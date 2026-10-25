// 我的相册 · 安装程序 / 卸载程序
//
// 同一个源文件编译两个 exe（tools/pack.js 会做）：
//   csc /target:winexe /out:安装包.exe       /resource:payload.bin,payload.bin … MyAlbumSetup.cs
//   csc /target:winexe /out:MyAlbumUninstall.exe /define:UNINSTALL …            MyAlbumSetup.cs
//
// 为什么自己写而不用 Inno Setup：那台打包机上没装（也没网）。这个安装程序只依赖
// .NET Framework（Win10/11 自带），编译只需要系统自带的 csc。
//
// 载荷格式（payload.bin，由 tools/pack.js 生成，见那个文件里的说明）：
//   MYALBUM1\n
//   <条目数>\n
//   <相对路径 UTF-8>\t<字节数>\n   × N
//   \n
//   <把所有文件按上面顺序首尾相接、整段 raw deflate 压缩后的字节>
// 顺序读取即可，不需要随机访问，所以 C# 这边只用一个 DeflateStream。
//
// 默认装到 %USERPROFILE%\AppData\Local\Programs\我的相册（按用户，不弹 UAC）；
// 装到别处（比如 Program Files）时如果写不进去，会提示改用管理员身份运行。
//
// 命令行（自动化/排查用）：
//   /silent            静默安装（不显示界面）
//   /dir=<路径>        指定安装目录
//   /noshortcuts       不创建桌面和开始菜单快捷方式
//   /noregistry        不写"程序和功能"里的卸载项
//   /nolaunch          安装完成后不启动
//   /noelevate         卸载时不尝试提权
//   /uninstall         走卸载流程（卸载器 exe 默认就是它）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MyAlbumSetup
{
    internal static class Program
    {
        private const string AppTitle = "我的相册";
        private const string AppExeName = "MyAlbum.exe";
        private const string UninstallExeName = "MyAlbumUninstall.exe";
        private const string RegistryKeyPath =
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\我的相册";
        private const string ShortcutName = "我的相册.lnk";
        private const string TaskName = "我的相册";

#if UNINSTALL
        private const string Mode = "uninstall";
#else
        private const string Mode = "install";
#endif

        private static string installDir = "";
        private static bool silent;
        private static bool noShortcuts;
        private static bool noRegistry;
        private static bool noLaunch;
        private static bool noElevate;
        private static bool noTask;
        private static string taskNote = "";

        private static readonly List<Entry> entries = new List<Entry>();

        private sealed class Entry
        {
            public string RelativePath;
            public long Size;
        }

        [STAThread]
        private static void Main(string[] args)
        {
            ParseArguments(args);

            if (installDir.Length == 0)
            {
                installDir = Mode == "install" ? DefaultInstallDir() : "";
            }

            if (Mode == "uninstall")
            {
                RunUninstall();
                return;
            }

            // 安装时请求一次管理员权限：只是为了登记"免 UAC 启动"的计划任务。
            // 用户拒绝也不影响安装，只是启动时会以普通身份运行（界面上会说明）。
            if (!IsElevated() && !noElevate && !noTask)
            {
                if (TrySelfElevate(args))
                {
                    return;
                }
            }

            if (silent)
            {
                try
                {
                    DoInstall(null, null);
                    Console.WriteLine("装好了：" + installDir);

                    if (taskNote.Length > 0)
                    {
                        Console.WriteLine(taskNote);
                    }

                    Environment.ExitCode = 0;
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("安装失败：" + error.Message);
                    Environment.ExitCode = 1;
                }

                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using (var form = new SetupForm())
            {
                Application.Run(form);
            }
        }

        private static bool TrySelfElevate(string[] args)
        {
            try
            {
                var info = new ProcessStartInfo(Application.ExecutablePath);
                info.UseShellExecute = true;
                info.Verb = "runas";

                foreach (string argument in args)
                {
                    info.Arguments += (info.Arguments.Length == 0 ? "" : " ") + argument;
                }

                Process.Start(info);
                return true;
            }
            catch
            {
                // 用户点了"否"：继续用普通身份安装（计划任务那步会失败，界面上会说明）
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

        // --- 参数 -----------------------------------------------------------------

        private static void ParseArguments(string[] args)
        {
            foreach (string raw in args)
            {
                string argument = raw.Trim();
                string lower = argument.ToLowerInvariant();

                if (lower == "/silent" || lower == "-silent")
                {
                    silent = true;
                }
                else if (lower == "/noshortcuts")
                {
                    noShortcuts = true;
                }
                else if (lower == "/noregistry")
                {
                    noRegistry = true;
                }
                else if (lower == "/notask")
                {
                    noTask = true;
                }
                else if (lower == "/nolaunch")
                {
                    noLaunch = true;
                }
                else if (lower == "/noelevate")
                {
                    noElevate = true;
                }
                else if (lower.StartsWith("/dir="))
                {
                    installDir = argument.Substring(5).Trim().Trim('"');
                }
                else if (lower.StartsWith("/delete="))
                {
                    // 卸载时用：要删的目标目录
                    installDir = argument.Substring(8).Trim().Trim('"');
                }
            }
        }

        // --- 路径（注意：提权后 GetFolderPath 可能指向管理员的用户目录，
        //     所以优先用从父进程继承下来的环境变量） ------------------------------

        private static string DefaultInstallDir()
        {
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");
            string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");

            if (!string.IsNullOrEmpty(profile))
            {
                return Path.Combine(profile, @"AppData\Local\Programs\" + AppTitle);
            }

            if (!string.IsNullOrEmpty(localAppData))
            {
                return Path.Combine(localAppData, @"Programs\" + AppTitle);
            }

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\" + AppTitle);
        }

        private static string DesktopDir()
        {
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");

            if (!string.IsNullOrEmpty(profile) && Directory.Exists(Path.Combine(profile, "Desktop")))
            {
                return Path.Combine(profile, "Desktop");
            }

            return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }

        private static string StartMenuDir()
        {
            string appData = Environment.GetEnvironmentVariable("APPDATA");

            if (!string.IsNullOrEmpty(appData))
            {
                return Path.Combine(appData, @"Microsoft\Windows\Start Menu\Programs");
            }

            return Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        }

        // --- 载荷读取 -------------------------------------------------------------

        private static Stream OpenPayload()
        {
            var assembly = Assembly.GetExecutingAssembly();

            foreach (string name in assembly.GetManifestResourceNames())
            {
                if (name.EndsWith("payload.bin", StringComparison.OrdinalIgnoreCase))
                {
                    return assembly.GetManifestResourceStream(name);
                }
            }

            throw new InvalidOperationException("安装包里没有找到载荷数据（payload.bin）");
        }

        private static string ReadHeaderLine(Stream stream)
        {
            var bytes = new List<byte>();
            int value;

            while ((value = stream.ReadByte()) >= 0)
            {
                if (value == (int)'\n')
                {
                    break;
                }

                if (value != (int)'\r')
                {
                    bytes.Add((byte)value);
                }
            }

            return Encoding.UTF8.GetString(bytes.ToArray());
        }

        private static void ReadManifest(Stream stream)
        {
            string magic = ReadHeaderLine(stream);

            if (magic != "MYALBUM1")
            {
                throw new InvalidOperationException("载荷格式不对（" + magic + "）");
            }

            int count;

            if (!int.TryParse(ReadHeaderLine(stream), out count))
            {
                throw new InvalidOperationException("载荷条目数读不出来");
            }

            for (int index = 0; index < count; index += 1)
            {
                string line = ReadHeaderLine(stream);
                int separator = line.LastIndexOf('\t');

                if (separator <= 0)
                {
                    throw new InvalidOperationException("载荷条目格式不对：" + line);
                }

                entries.Add(new Entry
                {
                    RelativePath = line.Substring(0, separator),
                    Size = long.Parse(line.Substring(separator + 1)),
                });
            }

            ReadHeaderLine(stream); // 空行 = 头结束
        }

        // --- 安装 -----------------------------------------------------------------

        private static void EnsureWritable(string target)
        {
            Directory.CreateDirectory(target);
            string probe = Path.Combine(target, ".my-album-write-test");

            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }

        private static void DoInstall(Action<int, int, string> progress, Action<string> status)
        {
            // 覆盖安装（升级/重装）时先把正在跑的相册关掉，否则 exe/node 被占用会写不进去
            if (Directory.Exists(installDir))
            {
                if (status != null)
                {
                    status("正在关掉正在运行的相册…");
                }

                KillRunningApp();
            }

            EnsureWritable(installDir);

            long extracted = 0;
            long total = 0;

            using (Stream payload = OpenPayload())
            {
                ReadManifest(payload);

                foreach (Entry entry in entries)
                {
                    total += entry.Size;
                }

                using (var deflate = new DeflateStream(payload, CompressionMode.Decompress))
                {
                    var buffer = new byte[64 * 1024];

                    for (int index = 0; index < entries.Count; index += 1)
                    {
                        Entry entry = entries[index];
                        string target = Path.Combine(installDir, entry.RelativePath);
                        string folder = Path.GetDirectoryName(target);

                        if (!string.IsNullOrEmpty(folder))
                        {
                            Directory.CreateDirectory(folder);
                        }

                        long remaining = entry.Size;

                        using (var output = new FileStream(target, FileMode.Create, FileAccess.Write))
                        {
                            while (remaining > 0)
                            {
                                int want = (int)Math.Min(buffer.Length, remaining);
                                int got = deflate.Read(buffer, 0, want);

                                if (got <= 0)
                                {
                                    throw new InvalidOperationException(
                                        "载荷数据不完整（" + entry.RelativePath + "）");
                                }

                                output.Write(buffer, 0, got);
                                remaining -= got;
                                extracted += got;
                            }
                        }

                        if (progress != null)
                        {
                            progress(index + 1, entries.Count, entry.RelativePath);
                        }
                    }
                }
            }

            // 缓存和索引目录先建出来，用户一眼能看到数据在哪
            Directory.CreateDirectory(Path.Combine(installDir, "cache"));
            Directory.CreateDirectory(Path.Combine(installDir, "data"));

            if (!noShortcuts)
            {
                if (status != null)
                {
                    status("正在创建快捷方式…");
                }

                CreateShortcut(Path.Combine(StartMenuDir(), ShortcutName),
                    Path.Combine(installDir, AppExeName), installDir);
                CreateShortcut(Path.Combine(DesktopDir(), ShortcutName),
                    Path.Combine(installDir, AppExeName), installDir);
            }

            if (!noRegistry)
            {
                if (status != null)
                {
                    status("正在登记卸载信息…");
                }

                WriteUninstallRegistry();
            }

            if (!noTask)
            {
                if (status != null)
                {
                    status("正在登记免 UAC 的启动任务…");
                }

                try
                {
                    RegisterElevatedTask();
                    taskNote = "启动时不再弹 UAC（已登记管理员启动任务）";
                }
                catch (Exception error)
                {
                    // 这一步失败不影响安装：只是启动时会以普通身份运行
                    taskNote = "没能登记管理员启动任务（" + error.Message + "）——\r\n" +
                               "启动时会以普通身份运行；需要的话右键安装包选「以管理员身份运行」再装一次";
                }
            }
        }

        // 登记一个"以最高权限运行、没有触发器"的计划任务。
        // 启动器不是管理员时会 `schtasks /Run` 触发它 —— 这样每次启动都是管理员身份，
        // 但**不会再弹 UAC**（用户明确要求：别每次都弹）。
        // 登记这一步本身需要管理员，所以安装程序会请求提权（只弹这一次）。
        private static void RegisterElevatedTask()
        {
            string launcher = Path.Combine(installDir, AppExeName);
            string script =
                "$action = New-ScheduledTaskAction -Execute '" + launcher.Replace("'", "''") + "' " +
                "-Argument '--via-task';" +
                "$principal = New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\\$env:USERNAME\" " +
                "-LogonType Interactive -RunLevel Highest;" +
                "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries " +
                "-DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero);" +
                "Register-ScheduledTask -TaskName '" + TaskName + "' -Action $action " +
                "-Principal $principal -Settings $settings -Force | Out-Null";

            var outcome = RunPowerShell(script);

            if (outcome != 0)
            {
                throw new InvalidOperationException(
                    "登记计划任务失败（退出码 " + outcome + "）—— 启动时会以普通身份运行，" +
                    "如果浏览器打不开窗口，可以右键安装包用管理员身份再装一次。");
            }
        }

        private static void RemoveElevatedTask()
        {
            RunPowerShell(
                "Unregister-ScheduledTask -TaskName '" + TaskName + "' -Confirm:$false " +
                "-ErrorAction SilentlyContinue | Out-Null");
        }

        private static int RunPowerShell(string script)
        {
            try
            {
                var info = new ProcessStartInfo("powershell.exe");
                info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" +
                    script.Replace("\"", "\\\"") + "\"";
                info.CreateNoWindow = true;
                info.UseShellExecute = false;

                using (Process process = Process.Start(info))
                {
                    if (!process.WaitForExit(60000))
                    {
                        return -1;
                    }

                    return process.ExitCode;
                }
            }
            catch
            {
                return -1;
            }
        }

        private static void CreateShortcut(string linkPath, string targetPath, string workingDir)
        {
            try
            {
                string folder = Path.GetDirectoryName(linkPath);

                if (!string.IsNullOrEmpty(folder))
                {
                    Directory.CreateDirectory(folder);
                }

                object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
                Type shellType = shell.GetType();
                object shortcut = shellType.InvokeMember("CreateShortcut",
                    BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });

                Type shortcutType = shortcut.GetType();
                SetProperty(shortcutType, shortcut, "TargetPath", targetPath);
                SetProperty(shortcutType, shortcut, "WorkingDirectory", workingDir);
                SetProperty(shortcutType, shortcut, "IconLocation", targetPath);
                SetProperty(shortcutType, shortcut, "Description", AppTitle);
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch (Exception error)
            {
                throw new InvalidOperationException(
                    "创建快捷方式失败（" + linkPath + "）：" + error.Message);
            }
        }

        private static void SetProperty(Type type, object instance, string name, object value)
        {
            type.InvokeMember(name, BindingFlags.SetProperty, null, instance, new object[] { value });
        }

        private static void WriteUninstallRegistry()
        {
            try
            {
                string version = ReadInstalledVersion();

                using (RegistryKey key = Registry.LocalMachine.CreateSubKey(RegistryKeyPath))
                {
                    key.SetValue("DisplayName", AppTitle);
                    key.SetValue("DisplayVersion", version);
                    key.SetValue("Publisher", "My Album");
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("DisplayIcon", Path.Combine(installDir, AppExeName));
                    key.SetValue("UninstallString",
                        "\"" + Path.Combine(installDir, UninstallExeName) + "\"");
                    key.SetValue("QuietUninstallString",
                        "\"" + Path.Combine(installDir, UninstallExeName) + "\" /silent");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch (Exception error)
            {
                // 没提权时写不了 HKLM —— 不影响使用，界面上会说明
                throw new InvalidOperationException(
                    "写卸载信息失败（需要管理员权限）：" + error.Message);
            }
        }

        private static string ReadInstalledVersion()
        {
            try
            {
                string manifest = Path.Combine(installDir, "install.json");

                if (File.Exists(manifest))
                {
                    string text = File.ReadAllText(manifest, Encoding.UTF8);
                    var match = System.Text.RegularExpressions.Regex.Match(
                        text, "\"version\"\\s*:\\s*\"([^\"]+)\"");

                    if (match.Success)
                    {
                        return match.Groups[1].Value;
                    }
                }
            }
            catch
            {
            }

            return "2.0.0";
        }

        // --- 卸载 -----------------------------------------------------------------

        private static void RunUninstall()
        {
            if (installDir.Length == 0)
            {
                installDir = Path.GetDirectoryName(Application.ExecutablePath);
            }

            if (!silent)
            {
                DialogResult answer = MessageBox.Show(
                    "确定要卸载" + AppTitle + "吗？\r\n\r\n" +
                    "安装目录（包括缓存和索引）：\r\n" + installDir + "\r\n\r\n" +
                    "缓存和索引会被一起删掉，原始照片不受影响。",
                    AppTitle + " · 卸载",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);

                if (answer != DialogResult.Yes)
                {
                    return;
                }
            }

            if (!IsElevated() && !noElevate && TrySelfElevateForUninstall())
            {
                return;
            }

            try
            {
                KillRunningApp();
                RemoveShortcuts();
                RemoveElevatedTask();

                if (!noRegistry)
                {
                    try
                    {
                        Registry.LocalMachine.DeleteSubKeyTree(RegistryKeyPath, false);
                    }
                    catch
                    {
                        // 没权限删就算了
                    }
                }

                ScheduleDirectoryRemoval(installDir);

                if (silent)
                {
                    Console.WriteLine("卸载完成：" + installDir);
                }
                else
                {
                    MessageBox.Show(
                        AppTitle + " 已卸载。\r\n\r\n（缓存和索引已一并删除）",
                        AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
            }
            catch (Exception error)
            {
                if (silent)
                {
                    Console.Error.WriteLine("卸载失败：" + error.Message);
                    Environment.ExitCode = 1;
                }
                else
                {
                    MessageBox.Show("卸载时出错：" + error.Message, AppTitle,
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static bool TrySelfElevateForUninstall()
        {
            try
            {
                var info = new ProcessStartInfo(Application.ExecutablePath);
                info.UseShellExecute = true;
                info.Verb = "runas";
                info.Arguments = "/silent /delete=\"" + installDir + "\"";

                Process.Start(info);
                return true;
            }
            catch
            {
                // 用户拒绝了 UAC：继续用普通身份卸载（卸载自己的目录通常也没问题）
                return false;
            }
        }

        private static void KillRunningApp()
        {
            string root = installDir.TrimEnd('\\') + "\\";

            foreach (string name in new[] { "MyAlbum", "node" })
            {
                foreach (Process process in Process.GetProcessesByName(name))
                {
                    try
                    {
                        string path = process.MainModule.FileName;

                        if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        {
                            process.Kill();
                            process.WaitForExit(4000);
                        }
                    }
                    catch
                    {
                        // 拿不到别的进程的路径就跳过（不是我们的就不动它）
                    }
                }
            }
        }

        private static void RemoveShortcuts()
        {
            foreach (string link in new[]
            {
                Path.Combine(StartMenuDir(), ShortcutName),
                Path.Combine(DesktopDir(), ShortcutName),
            })
            {
                try
                {
                    if (File.Exists(link))
                    {
                        File.Delete(link);
                    }
                }
                catch
                {
                }
            }
        }

        // 卸载器自己就在要删的目录里，删不掉自己 —— 交给一个延时的小 cmd 来收尾
        private static void ScheduleDirectoryRemoval(string target)
        {
            string command = "/c ping -n 3 127.0.0.1 > nul & rmdir /s /q \"" + target + "\"";

            try
            {
                var info = new ProcessStartInfo("cmd.exe", command);
                info.CreateNoWindow = true;
                info.UseShellExecute = false;
                Process.Start(info);
            }
            catch
            {
                // 实在不行就留给用户手动删
            }
        }

        // --- 安装界面 -------------------------------------------------------------

        private sealed class SetupForm : Form
        {
            private readonly TextBox dirBox;
            private readonly CheckBox desktopBox;
            private readonly CheckBox launchBox;
            private readonly ProgressBar progress;
            private readonly Label status;
            private readonly Button installButton;
            private readonly Button cancelButton;
            private bool finished;

            public SetupForm()
            {
                Text = AppTitle + " 安装程序";
                ClientSize = new Size(520, 250);
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                MinimizeBox = false;
                StartPosition = FormStartPosition.CenterScreen;

                var heading = new Label();
                heading.Text = "把" + AppTitle + "装到这台电脑上";
                heading.Font = new Font(FontFamily.GenericSansSerif, 11f, FontStyle.Bold);
                heading.SetBounds(16, 14, 480, 26);

                var note = new Label();
                note.Text = "自包含（自带 Node 运行时），不需要预装任何东西。\r\n" +
                            "装的时候会请求一次管理员权限（用于登记免 UAC 启动任务），之后启动不再弹窗。\r\n" +
                            "缓存和索引会放在安装目录里，卸载时一起删除。";
                note.SetBounds(16, 44, 480, 54);

                var dirLabel = new Label();
                dirLabel.Text = "安装到：";
                dirLabel.SetBounds(16, 92, 60, 22);

                dirBox = new TextBox();
                dirBox.Text = DefaultInstallDir();
                dirBox.SetBounds(80, 90, 350, 24);

                var browse = new Button();
                browse.Text = "浏览…";
                browse.SetBounds(438, 89, 70, 26);
                browse.Click += delegate { BrowseForFolder(); };

                desktopBox = new CheckBox();
                desktopBox.Text = "创建桌面快捷方式";
                desktopBox.Checked = true;
                desktopBox.SetBounds(80, 122, 220, 24);

                launchBox = new CheckBox();
                launchBox.Text = "安装完成后启动";
                launchBox.Checked = true;
                launchBox.SetBounds(300, 122, 200, 24);

                progress = new ProgressBar();
                progress.SetBounds(80, 156, 428, 18);
                progress.Minimum = 0;
                progress.Maximum = 100;

                status = new Label();
                status.Text = "准备好后点「安装」开始。";
                status.SetBounds(80, 178, 428, 20);

                installButton = new Button();
                installButton.Text = "安装";
                installButton.SetBounds(340, 206, 80, 30);
                installButton.Click += delegate { StartInstall(); };

                cancelButton = new Button();
                cancelButton.Text = "取消";
                cancelButton.SetBounds(428, 206, 80, 30);
                cancelButton.Click += delegate { Close(); };

                Controls.Add(heading);
                Controls.Add(note);
                Controls.Add(dirLabel);
                Controls.Add(dirBox);
                Controls.Add(browse);
                Controls.Add(desktopBox);
                Controls.Add(launchBox);
                Controls.Add(progress);
                Controls.Add(status);
                Controls.Add(installButton);
                Controls.Add(cancelButton);
            }

            private void BrowseForFolder()
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "选择安装位置";
                    dialog.SelectedPath = dirBox.Text;

                    if (dialog.ShowDialog(this) == DialogResult.OK)
                    {
                        dirBox.Text = dialog.SelectedPath;
                    }
                }
            }

            private void StartInstall()
            {
                installDir = dirBox.Text.Trim();
                noShortcuts = !desktopBox.Checked;
                noLaunch = !launchBox.Checked;

                if (installDir.Length == 0)
                {
                    MessageBox.Show("请先选择安装目录。", AppTitle);
                    return;
                }

                if (installDir.StartsWith(Environment.GetFolderPath(
                        Environment.SpecialFolder.Windows), StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show("不要装到 Windows 目录里，换个位置吧。", AppTitle);
                    return;
                }

                installButton.Enabled = false;
                cancelButton.Enabled = false;

                string failure = null;

                try
                {
                    DoInstall(
                        delegate(int done, int total, string name)
                        {
                            progress.Value = Math.Min(100, (int)(done * 100L / Math.Max(1, total)));
                            status.Text = "正在安装：" + name;
                            Application.DoEvents();
                        },
                        delegate(string text)
                        {
                            status.Text = text;
                            Application.DoEvents();
                        });
                }
                catch (Exception error)
                {
                    failure = error.Message;
                }

                if (failure != null)
                {
                    installButton.Enabled = true;
                    cancelButton.Enabled = true;
                    progress.Value = 0;
                    status.Text = "安装失败。";
                    MessageBox.Show(
                        "安装失败：" + failure + "\r\n\r\n" +
                        "如果是因为目录写不进去，换一个目录，或者右键安装包选「以管理员身份运行」。",
                        AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                finished = true;
                progress.Value = 100;
                status.Text = "安装完成。";
                Application.DoEvents();

                if (!noLaunch)
                {
                    LaunchApp();
                }

                MessageBox.Show(
                    AppTitle + " 装好了。\r\n\r\n" +
                    "安装目录：" + installDir + "\r\n" +
                    "缓存和索引也在里面（cache、data）。\r\n\r\n" +
                    (taskNote.Length > 0 ? taskNote + "\r\n\r\n" : "") +
                    "双击桌面快捷方式启动。想换照片文件夹时，界面里点「选择照片文件夹」；\r\n" +
                    "万一那个窗口出不来，托盘图标右键有「手动指定照片文件夹…」。",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);

                Close();
            }

            private void LaunchApp()
            {
                try
                {
                    var info = new ProcessStartInfo(Path.Combine(installDir, AppExeName));
                    info.UseShellExecute = true;
                    info.WorkingDirectory = installDir;
                    Process.Start(info);
                }
                catch
                {
                }
            }

            protected override void OnFormClosing(FormClosingEventArgs e)
            {
                if (!finished && !installButton.Enabled)
                {
                    e.Cancel = true;
                }

                base.OnFormClosing(e);
            }
        }
    }
}