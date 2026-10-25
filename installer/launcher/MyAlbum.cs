// 我的相册 · 启动器
//
// 干的事（按用户定的方案）：
//   1. 单实例（互斥体名字带安装目录，不同副本互不干扰）—— 避免两个实例抢端口
//   2. 找一个空闲端口（先试 3000，占用就往后找），把安装目录/日志路径用环境变量传给服务
//   3. 用自带的 runtime\node.exe 拉起 app\server.js（CreateNoWindow，不弹黑框）
//   4. 等 /api/cache 能响应，再用**你默认的那个浏览器**（Chrome/Edge）以 --app= 打开
//      无边框窗口；然后问服务端 /api/health 确认"页面真的被加载了"，
//      没加载出来就自动回退成普通浏览器窗口（保证用户一定看得到界面）
//   5. 托盘图标：打开相册 / 用普通浏览器窗口打开 / 打开缓存目录 / 退出
//
// 编译（打包脚本 tools/pack.js 会做，也可以手动）：
//   csc /target:winexe /out:MyAlbum.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll
//       /win32icon:assets\icon.ico installer\launcher\MyAlbum.cs
//
// 命令行参数：
//   --check        只验证"能不能起来"：拉起服务、探测接口、打印结果、退出（打包自检用）
//   --no-browser   不打开窗口（调试用）
//   --plain        不用无边框窗口，直接用默认浏览器开一个普通窗口
//
// 日志：cache\launcher.log（启动器自己） + cache\server.log（服务端）

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace MyAlbum
{
    internal static class Program
    {
        private const string AppTitle = "我的相册";

        private static string installDir;
        private static string appDir;
        private static string cacheDir;
        private static string logFile;
        private static string launcherLogFile;
        private static string nodeExe;
        private static Process serverProcess;
        private static NotifyIcon tray;
        private static int port;
        private static bool checkOnly;
        private static bool plainWindow;

        // 单实例：互斥体名字带上安装目录，**不同副本之间不要互相挡**
// （比如打包自检跑的是 staging，用户跑的是成品目录，用同一个名字会互相干扰）。
        // 自检模式（--check）完全不碰互斥体，保证任何时候都能跑起来验一次。
        private static string InstanceMutexName()
        {
            using (var sha = System.Security.Cryptography.SHA1.Create())
            {
                byte[] hash = sha.ComputeHash(
                    System.Text.Encoding.UTF8.GetBytes(installDir.ToLowerInvariant()));

                return "Local\\MyAlbum-" + BitConverter.ToString(hash, 0, 8).Replace("-", "");
            }
        }

        // 用户要"以管理员身份运行"，但**不要每次都弹 UAC**。
//
// 做法：安装时登记一个"以最高权限运行、没有触发器"的计划任务（见安装器 MyAlbumSetup.cs）。
// 启动器发现自己不是管理员时，就用 `schtasks /Run` 触发那个任务 —— 它会以管理员身份
// 拉起同一个 exe，而**不会再弹 UAC**（任务已经带着最高权限了）。
//   · 任务不存在（免安装版、没提权装过）→ 记日志，就以普通身份继续运行
//   · 触发出来的那个实例带着 --via-task 参数：万一那时还不是管理员，直接继续，
//     否则会无限互相触发
//   · --no-elevate 可以强制不提权；--check / --no-browser 也不提权
private const string TaskName = "我的相册";
private const string ViaTaskArgument = "--via-task";

private static bool TryRunScheduledTask()
{
    try
    {
        var info = new ProcessStartInfo("schtasks.exe", "/Run /TN \"" + TaskName + "\"");
        info.CreateNoWindow = true;
        info.UseShellExecute = false;

        using (Process task = Process.Start(info))
        {
            task.WaitForExit(15000);
            bool ok = task.ExitCode == 0;

            Log(ok
                ? "  已用计划任务以管理员身份启动（不弹 UAC）"
                : "  计划任务启动失败（退出码 " + task.ExitCode + "）");

            return ok;
        }
    }
    catch (Exception error)
    {
        Log("  触发计划任务失败：" + error.Message);
        return false;
    }
}

        private static bool IsElevated()
        {
            try
            {
                var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                var principal = new System.Security.Principal.WindowsPrincipal(identity);

                return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }

// 托盘里的"手动指定照片文件夹…"：直接在启动器进程里弹原生对话框，
        // 再把选中的路径 PUT 给服务端。界面里那个按钮走的是
        // "PowerShell + WinForms" 那条路，万一它出问题，这里是保底手段。
        private static void PickFolderFromTray()
        {
            try
            {
                var owner = new Form();
                owner.Text = AppTitle;
                owner.TopMost = true;
                owner.ShowInTaskbar = false;
                owner.FormBorderStyle = FormBorderStyle.None;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.Size = new Size(1, 1);
                owner.Opacity = 0;
                owner.Show();

                string selected;

                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "选择存放照片的文件夹";
                    dialog.ShowNewFolderButton = false;

                    DialogResult result = dialog.ShowDialog(owner);
                    selected = result == DialogResult.OK ? dialog.SelectedPath : "";
                }

                owner.Close();
                owner.Dispose();

                if (string.IsNullOrEmpty(selected))
                {
                    return;
                }

                if (SetPhotoRoot(selected))
                {
                    Balloon("照片文件夹已设置为：" + selected + "\r\n如果页面没变，按 F5 刷新一下。");
                }
                else
                {
                    Balloon("没能设置照片文件夹，请看 cache\\server.log");
                }
            }
            catch (Exception error)
            {
                Log("手动指定照片文件夹失败：" + error.Message);
                Balloon("打开文件夹选择窗口失败：" + error.Message);
            }
        }

        private static bool SetPhotoRoot(string folder)
        {
            try
            {
                byte[] data = System.Text.Encoding.UTF8.GetBytes(
                    "{\"path\":\"" + folder.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}");
                var request = (HttpWebRequest)WebRequest.Create(BrowserUrl(port) + "api/source");
                request.Method = "PUT";
                request.ContentType = "application/json";
                request.ContentLength = data.Length;
                request.Timeout = 20000;

                using (var stream = request.GetRequestStream())
                {
                    stream.Write(data, 0, data.Length);
                }

                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    int status = (int)response.StatusCode;
                    Log("已设置照片文件夹：" + folder + "（HTTP " + status + "）");
                    return status < 300;
                }
            }
            catch (Exception error)
            {
                Log("设置照片文件夹失败：" + error.Message);
                return false;
            }
        }

        private static void Balloon(string message)
        {
            try
            {
                if (tray != null)
                {
                    tray.BalloonTipTitle = AppTitle;
                    tray.BalloonTipText = message;
                    tray.ShowBalloonTip(6000);
                }
            }
            catch
            {
            }
        }

        // 兜底提权手段（要显式加 --uac 才用）：会弹 UAC。
        // 默认走的是计划任务那条路，不弹窗。
        private static bool TrySelfElevate(string[] args)
        {
            try
            {
                var info = new ProcessStartInfo(Application.ExecutablePath);
                info.UseShellExecute = true;
                info.Verb = "runas";
                info.WorkingDirectory = installDir;

                foreach (string argument in args)
                {
                    if (!string.Equals(argument, "--no-elevate", StringComparison.OrdinalIgnoreCase))
                    {
                        info.Arguments += (info.Arguments.Length == 0 ? "" : " ") + argument;
                    }
                }

                Process.Start(info);
                return true;
            }
            catch (Exception error)
            {
                // 1223 = 用户在 UAC 里点了"否"
                Log("提权失败（" + error.Message + "）：继续以普通身份运行");
                return false;
            }
        }

[STAThread]
        private static void Main(string[] args)
        {
            checkOnly = Array.IndexOf(args, "--check") >= 0;
            bool noBrowser = checkOnly || Array.IndexOf(args, "--no-browser") >= 0;
            plainWindow = Array.IndexOf(args, "--plain") >= 0;

            installDir = Path.GetDirectoryName(Application.ExecutablePath);
            appDir = Path.Combine(installDir, "app");
            cacheDir = Path.Combine(installDir, "cache");
            logFile = Path.Combine(cacheDir, "server.log");
            launcherLogFile = Path.Combine(cacheDir, "launcher.log");
            nodeExe = Path.Combine(installDir, "runtime", "node.exe");

            Log("==== 启动器启动 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ====");
            Log("  程序：" + Application.ExecutablePath);
            Log("  参数：" + (args.Length == 0 ? "(无)" : string.Join(" ", args)));
            Log("  管理员身份：" + IsElevated());

            if (checkOnly)
            {
                Run(true, true);
                return;
            }

            bool noElevate = Array.IndexOf(args, "--no-elevate") >= 0 || noBrowser;
            bool cameFromTask = Array.IndexOf(args, ViaTaskArgument) >= 0;

            if (!IsElevated() && !noElevate && !cameFromTask)
            {
                // 优先走计划任务：以管理员身份启动，而且**不弹 UAC**
                Log("  当前不是管理员：试试用计划任务静默提权");
                Log("  想强制以普通身份运行，用 --no-elevate");

                if (TryRunScheduledTask())
                {
                    return;
                }

                if (Array.IndexOf(args, "--uac") >= 0 && TrySelfElevate(args))
                {
                    return;
                }

                Log("  计划任务不可用（没装过？），就以普通身份继续运行");
            }

            if (!File.Exists(nodeExe) || !File.Exists(Path.Combine(appDir, "server.js")))
            {
                Fail("安装不完整：找不到 runtime\\node.exe 或 app\\server.js。\r\n" +
                     "请重新安装，或把整个文件夹一起移动。");
                return;
            }

            // 单实例：同一个安装目录已经有一个在跑 → 把它的窗口再打开一次就行
            bool createdNew;
            using (var mutex = new Mutex(true, InstanceMutexName(), out createdNew))
            {
                if (!createdNew)
                {
                    int existingPort = ReadPortFile();
                    bool alive = ServerAnswers(existingPort);

                    Log("已经有一个实例在跑（端口 " + existingPort + "，可访问=" + alive + "）");
                    Log("这次只把窗口打开，不再起第二个服务");

                    if (alive)
                    {
                        OpenWindow(BrowserUrl(existingPort));
                        WaitForPageLoad(LastPageAt(existingPort), 15000);
                        return;
                    }

                    // 记录里的服务其实已经没了（比如上次崩了）：继续往下走，自己起一个
                    Log("记录里的服务不在了，改为自己启动一个");
                }

                try
                {
                    Run(false, noBrowser);
                }
                finally
                {
                    Shutdown();
                    GC.KeepAlive(mutex);
                }
            }
        }

        private static bool ServerAnswers(int targetPort)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + targetPort + "/api/health");
                request.Timeout = 2000;

                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void Run(bool checkOnlyMode, bool noBrowser)
        {
            Directory.CreateDirectory(cacheDir);
            Directory.CreateDirectory(Path.Combine(installDir, "data"));

            port = FindFreePort();
            WritePortFile(port);

            if (!StartServer())
            {
                Fail("服务没能启动。日志：\r\n" + logFile);
                return;
            }

            if (!WaitForServer(checkOnlyMode ? 30000 : 20000))
            {
                Fail("服务起来了但接口没有响应。日志：\r\n" + logFile);
                return;
            }

            if (checkOnlyMode)
            {
                // 打包自检：把结果写文件（GUI 程序没有控制台），然后等服务被叫停，
                // 期间外部可以对接口做真实探测。
                Console.WriteLine("OK port=" + port + " cache=" + cacheDir);
                File.WriteAllText(CheckFile, "OK port=" + port + " cache=" + cacheDir);

                var deadline = DateTime.UtcNow.AddSeconds(120);

                while (DateTime.UtcNow < deadline)
                {
                    if (File.Exists(StopFile))
                    {
                        break;
                    }

                    Thread.Sleep(200);
                }

                Shutdown();
                Environment.Exit(0);
                return;
            }

            if (!noBrowser)
            {
                RemoveLegacyBrowserProfile();

                Log("=== 打开窗口 ===");
                Log("  安装目录：" + installDir);
                Log("  端口：" + port);
                Log("  默认浏览器：" + (DefaultBrowserExe() ?? "(没认出来)"));

                bool loaded = false;

                if (!plainWindow)
                {
                    long baseline = LastPageRequestAt();
                    Log("  打开窗口前 lastPageAt=" + baseline);

                    // 1) 先按用户要的形态：无边框 --app 窗口
                    OpenWindow(BrowserUrl(port));

                    loaded = WaitForPageLoad(baseline, 8000);

                    Log(loaded
                        ? "  无边框窗口加载成功 ✓"
                        : "  8 秒内没有任何页面请求：无边框窗口没把页面加载出来");
                }

                if (!loaded)
                {
                    // 2) 退回普通的浏览器窗口（等价于手动在浏览器里打开这个地址）
                    long fallbackBaseline = LastPageRequestAt();
                    OpenPlainWindow(BrowserUrl(port));

                    loaded = WaitForPageLoad(fallbackBaseline, 8000);
                    Log(loaded
                        ? "  普通窗口加载成功 ✓"
                        : "  普通窗口也没加载出来");
                }

                if (!loaded)
                {
                    // 3) 兜底：自己弹一个小窗，把地址摆给用户，保证"一定有东西出现"
                    ShowNoticeWindow(BrowserUrl(port));
                }
            }

            StartTray();
            Application.Run(new TrayWindow());
        }

        private static string CheckFile
        {
            get { return Path.Combine(cacheDir, "pack-check.txt"); }
        }

        private static string StopFile
        {
            get { return Path.Combine(cacheDir, "pack-stop.txt"); }
        }

        private static string BrowserUrl(int actualPort)
        {
            return "http://127.0.0.1:" + actualPort + "/";
        }

        private static int FindFreePort()
        {
            // 先试常见的 3000，占用就往后找；全占满就让系统随便给一个
            for (int candidate = 3000; candidate <= 3010; candidate++)
            {
                if (IsFree(candidate))
                {
                    return candidate;
                }
            }

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int free = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();

            return free;
        }

        private static bool IsFree(int candidate)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, candidate);
                listener.Start();
                listener.Stop();
                return true;
            }
            catch (SocketException)
            {
                return false;
            }
        }

        private static string PortFile
        {
            get { return Path.Combine(cacheDir, "server.port"); }
        }

        private static void WritePortFile(int actualPort)
        {
            try
            {
                File.WriteAllText(PortFile, actualPort.ToString());
            }
            catch
            {
                // 写不了也无所谓，只是"二次启动时复用窗口"会退化成默认端口
            }
        }

        private static int ReadPortFile()
        {
            try
            {
                int saved;
                if (int.TryParse(File.ReadAllText(PortFile).Trim(), out saved))
                {
                    return saved;
                }
            }
            catch
            {
            }

            return 3000;
        }

        private static bool StartServer()
        {
            var info = new ProcessStartInfo(nodeExe, "server.js");
            info.WorkingDirectory = appDir;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.EnvironmentVariables["PORT"] = port.ToString();
            info.EnvironmentVariables["MY_ALBUM_INSTALL_DIR"] = installDir;
            info.EnvironmentVariables["MY_ALBUM_LOG_FILE"] = logFile;

            try
            {
                serverProcess = Process.Start(info);
                return serverProcess != null;
            }
            catch (Exception error)
            {
                File.AppendAllText(logFile, "启动 node 失败：" + error.Message + "\r\n");
                return false;
            }
        }

        private static bool WaitForServer(int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (DateTime.UtcNow < deadline)
            {
                if (serverProcess != null && serverProcess.HasExited)
                {
                    return false;
                }

                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(BrowserUrl(port) + "api/cache");
                    request.Timeout = 2000;
                    request.Method = "GET";

                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        return response.StatusCode == HttpStatusCode.OK;
                    }
                }
                catch
                {
                    Thread.Sleep(250);
                }
            }

            return false;
        }

        // 问服务端"最近一次有人请求首页/启动接口是什么时候"：
        // 用它来判断浏览器到底有没有把页面真的加载出来（比猜进程靠谱得多）。
        private static long LastPageAt(int targetPort)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + targetPort + "/api/health");
                request.Timeout = 2500;
                request.Method = "GET";

                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    string body = reader.ReadToEnd();
                    var match = System.Text.RegularExpressions.Regex.Match(
                        body, "\"lastPageAt\"\\s*:\\s*(\\d+)");

                    return match.Success ? long.Parse(match.Groups[1].Value) : 0;
                }
            }
            catch (Exception error)
            {
                Log("读 /api/health 失败：" + error.Message);
                return -1;
            }
        }

        private static long LastPageRequestAt()
        {
            return LastPageAt(port);
        }

        private static bool WaitForPageLoad(long baseline, int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);

            while (DateTime.UtcNow < deadline)
            {
                long now = LastPageRequestAt();

                if (now > baseline)
                {
                    return true;
                }

                Thread.Sleep(500);
            }

            return false;
        }

        // 浏览器：优先 Edge（Win10/11 自带），再 Chrome，都没有就交给系统默认浏览器。
        // 用 --app= 打开无边框窗口（没有地址栏/标签栏）。
        //
        // 为什么**不用** --user-data-dir 开独立 profile：那等于让浏览器以"全新用户"启动，
        // Edge 会跑首次运行/欢迎流程，窗口会长时间是**空白的** —— 实测用户就撞上了
        // （窗口灰的什么都没有，而那个 profile 的 Sessions 里其实记着我们的地址）。
        // 用用户自己的 profile 最稳；代价是没法再靠"命令行里带没带那个 profile 路径"
        // 判断窗口关没关，于是退出改成托盘里显式点（见 StartTray）。
        private static readonly string[] EdgeCandidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                @"Microsoft\Edge\Application\msedge.exe"),
            // 提权后 GetFolderPath(LocalApplicationData) 可能指向管理员账号的目录，
            // 而 %LOCALAPPDATA% 环境变量继承自启动我们的那个普通用户 —— 两个都试。
            CombineFromEnv("LOCALAPPDATA", @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Microsoft\Edge\Application\msedge.exe"),
        };

        private static readonly string[] ChromeCandidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                @"Google\Chrome\Application\chrome.exe"),
            CombineFromEnv("LOCALAPPDATA", @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Google\Chrome\Application\chrome.exe"),
        };

        private static string CombineFromEnv(string variable, string relative)
        {
            string root = Environment.GetEnvironmentVariable(variable);

            return string.IsNullOrEmpty(root) ? "" : Path.Combine(root, relative);
        }

        private static string FirstExisting(string[] candidates)
        {
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        // 用户平时用的是哪个浏览器，就优先用它开这个窗口：
        // 那样 profile 一定已经初始化过（不会撞上"首次运行"的空白窗口），手感也熟悉。
        private static string DefaultBrowserExe()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"))
                {
                    string progId = key == null ? "" : (key.GetValue("ProgId") as string) ?? "";

                    if (progId.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return FirstExisting(ChromeCandidates);
                    }

                    if (progId.IndexOf("edge", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return FirstExisting(EdgeCandidates);
                    }
                }
            }
            catch
            {
                // 读不到注册表就按 Edge → Chrome 的顺序试
            }

            return null;
        }

        private static void OpenWindow(string url)
        {
            // 优先：用户默认的那个浏览器（profile 已经初始化过，不会撞上首次运行的空白窗口），
            // 然后才是 Edge → Chrome，最后交给系统默认浏览器。
            var candidates = new System.Collections.Generic.List<string>();

            string preferred = DefaultBrowserExe();

            if (!string.IsNullOrEmpty(preferred))
            {
                candidates.Add(preferred);
            }

            candidates.Add(FirstExisting(EdgeCandidates));
            candidates.Add(FirstExisting(ChromeCandidates));

            string arguments = "--app=" + url + " --no-first-run --no-default-browser-check";
            bool opened = false;

            foreach (string browser in candidates)
            {
                if (string.IsNullOrEmpty(browser))
                {
                    continue;
                }

                Log("候选浏览器：" + browser + " 存在=" + File.Exists(browser));

                if (!File.Exists(browser))
                {
                    continue;
                }

                try
                {
                    var info = new ProcessStartInfo(browser, arguments);
                    info.UseShellExecute = false;

                    Process.Start(info);
                    Log("已用 " + Path.GetFileName(browser) + " 打开窗口：" + arguments);
                    opened = true;
                    break;
                }
                catch (Exception error)
                {
                    Log("用 " + browser + " 打开失败：" + error.Message);
                }
            }

            if (opened)
            {
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                Log("没找到 Edge/Chrome，已交给默认浏览器：" + url);
            }
            catch (Exception error)
            {
                Log("打开浏览器失败：" + error.Message);
            }
        }

        // 最后一道保险：浏览器怎么都不肯加载页面时，自己弹一个小窗，把地址和日志路径摆出来。
        // 目的是"无论浏览器抽什么风，用户都能看到东西、并且知道去哪看日志"。
        private static void ShowNoticeWindow(string url)
        {
            try
            {
                var form = new Form();
                form.Text = AppTitle + " · 手动打开";
                form.ClientSize = new Size(470, 250);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.MinimizeBox = false;
                form.Icon = LoadIcon();

                var message = new Label();
                message.Text = "相册已经在后台运行，但浏览器窗口没能自动打开。\r\n" +
                               "点下面的按钮，或者把这个地址复制到浏览器里：";
                message.SetBounds(16, 14, 430, 44);

                var urlBox = new TextBox();
                urlBox.Text = url;
                urlBox.ReadOnly = true;
                urlBox.SetBounds(16, 64, 430, 24);
                urlBox.SelectAll();

                var hints = new Label();
                hints.Font = new Font(FontFamily.GenericSansSerif, 8f);
                hints.Text = "缓存目录：" + cacheDir + "\r\n启动日志：" + launcherLogFile;
                hints.SetBounds(16, 94, 430, 36);

                var openButton = new Button();
                openButton.Text = "用默认浏览器打开";
                openButton.SetBounds(16, 146, 150, 30);
                openButton.Click += delegate { OpenPlainWindow(url); };

                var copyButton = new Button();
                copyButton.Text = "复制地址";
                copyButton.SetBounds(176, 146, 90, 30);
                copyButton.Click += delegate
                {
                    try { Clipboard.SetText(url); } catch { }
                };

                var cacheButton = new Button();
                cacheButton.Text = "打开缓存目录";
                cacheButton.SetBounds(276, 146, 120, 30);
                cacheButton.Click += delegate
                {
                    try { Process.Start("explorer.exe", "\"" + cacheDir + "\""); } catch { }
                };

                var quitButton = new Button();
                quitButton.Text = "退出相册";
                quitButton.SetBounds(16, 190, 150, 30);
                quitButton.Click += delegate { Application.Exit(); };

                form.Controls.Add(message);
                form.Controls.Add(urlBox);
                form.Controls.Add(hints);
                form.Controls.Add(openButton);
                form.Controls.Add(copyButton);
                form.Controls.Add(cacheButton);
                form.Controls.Add(quitButton);
                form.Show();
                form.BringToFront();

                Log("  已弹出提示窗口（浏览器没能自动打开，把地址摆给用户）");
            }
            catch (Exception error)
            {
                Log("  提示窗口也弹不出来：" + error.Message);
            }
        }

        private static bool OpenPlainWindow(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                Log("  已交给默认浏览器（普通窗口）：" + url);
                return true;
            }
            catch (Exception error)
            {
                Log("  普通窗口打开失败：" + error.Message);
                return false;
            }
        }

        // 老版本用过的独立浏览器 profile 已经不用了：顺手删掉，能省几十上百 MB
        private static void RemoveLegacyBrowserProfile()
        {
            string legacy = Path.Combine(cacheDir, "browser");

            try
            {
                if (Directory.Exists(legacy))
                {
                    Directory.Delete(legacy, true);
                    Log("已清理不再使用的浏览器 profile 目录：" + legacy);
                }
            }
            catch
            {
                // 删不掉（被占用）就算了，不影响使用
            }
        }

        private static void Log(string message)
        {
            // 注意：**不能**往 cache\server.log 里写 —— node 那边正拿它做追加写，
            // .NET 默认的 File.AppendAllText 只共享读，会被拒绝，异常一吞就什么都没了
            // （这个坑害我排查了半天：启动器的日志行全都不见了）。
            // 所以启动器单独写 cache\launcher.log，并且用 FileShare.ReadWrite 打开。
            try
            {
                Directory.CreateDirectory(cacheDir);

                using (var stream = new FileStream(
                    launcherLogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false)))
                {
                    writer.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message);
                }
            }
            catch
            {
            }
        }

        private static void StartTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开相册（无边框窗口）", null, delegate { OpenWindow(BrowserUrl(port)); });
            // 无边框窗口万一出问题（浏览器抽风/显卡驱动），这是"用普通标签页打开"的备用入口
            menu.Items.Add("用普通浏览器窗口打开", null, delegate { OpenPlainWindow(BrowserUrl(port)); });
            // 保底：界面里那个"选择照片文件夹"按钮万一出问题，这里能直接用原生对话框选
            menu.Items.Add("手动指定照片文件夹…", null, delegate { PickFolderFromTray(); });
            menu.Items.Add("打开缓存目录", null, delegate
            {
                try { Process.Start("explorer.exe", "\"" + cacheDir + "\""); }
                catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { Application.Exit(); });

            tray = new NotifyIcon();
            tray.Icon = LoadIcon();
            tray.Text = AppTitle + "（服务在后台运行，右键可退出）";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { OpenWindow(BrowserUrl(port)); };
            tray.BalloonTipTitle = AppTitle;
            tray.BalloonTipText = "窗口关掉后服务仍在后台运行；右键托盘图标可以退出。";
            tray.ShowBalloonTip(4000);
        }

        private static Icon LoadIcon()
        {
            try
            {
                string iconPath = Path.Combine(installDir, "app", "assets", "icon.ico");

                if (File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
            }
            catch
            {
            }

            return SystemIcons.Application;
        }

        // 常驻：托盘图标就是"应用还活着"的入口。
        // 关掉浏览器窗口**不会**自动退出（浏览器可能和已有的 Edge 混在一个进程里，
        // 没法可靠判断"我们那个窗口"关没关），所以要退出就点托盘里的"退出"；
        // 再点一次快捷方式会把已经开着的相册窗口重新打开（单实例那条路会复用服务）。
        private sealed class TrayWindow : Form
        {
            public TrayWindow()
            {
                ShowInTaskbar = false;
                WindowState = FormWindowState.Minimized;
                Opacity = 0;
                FormBorderStyle = FormBorderStyle.None;
            }

            protected override void OnLoad(EventArgs e)
            {
                base.OnLoad(e);
                Hide();
            }
        }

        private static void Shutdown()
        {
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
                tray = null;
            }

            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                    serverProcess.WaitForExit(3000);
                }
            }
            catch
            {
            }

            try
            {
                if (File.Exists(PortFile))
                {
                    File.Delete(PortFile);
                }
            }
            catch
            {
            }
        }

        private static void Fail(string message)
        {
            try
            {
                File.AppendAllText(logFile, message + "\r\n");

                if (checkOnly)
                {
                    File.WriteAllText(CheckFile, "FAIL " + message + "\r\n");
                }
            }
            catch
            {
            }

            if (checkOnly)
            {
                Shutdown();
                Environment.Exit(1);
                return;
            }

            MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}