// 我的相册 · 文件夹选择小工具
//
// 存在的理由：原来用 PowerShell 的 WinForms 选文件夹，踩了两个坑 ——
//   · PowerShell 5.1 跑在 .NET Framework 上，`FolderBrowserDialog.UseDescriptionForTitle`
//     这个属性在 .NET Framework 里**根本不存在**（只有 .NET Core 5+ 有），一赋值就抛异常；
//   · 提权之后 %TEMP% 可能写不进去（那是另一个坑，已经用多级回退解决）。
// 编译成小 exe 直接用，不经过 PowerShell：启动更快，也不用赌目标机器上的 .NET 版本。
//
// 用法（由 app\lib\folder-picker.js 调用）：
//   MyAlbumPicker.exe /out=<结果文件> [/initial=<起始目录>] [/selftest]
// 退出码：0 = 选了（结果写进 /out 指定的文件，UTF-8）
//         2 = 用户取消
//         1 = 出错（错误信息写到 stderr）
//
// 编译（tools/pack.js 会做）：
//   csc /target:winexe /out:MyAlbumPicker.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll MyAlbumPicker.cs

using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace MyAlbumPicker
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string resultPath = "";
            string initialPath = "";
            string description = "选择存放照片的文件夹";
            bool selfTest = false;

            foreach (string raw in args)
            {
                string argument = raw.Trim();

                if (argument.StartsWith("/out=", StringComparison.OrdinalIgnoreCase))
                {
                    resultPath = argument.Substring(5).Trim().Trim('"');
                }
                else if (argument.StartsWith("/initial=", StringComparison.OrdinalIgnoreCase))
                {
                    initialPath = argument.Substring(9).Trim().Trim('"');
                }
                else if (argument.StartsWith("/description=", StringComparison.OrdinalIgnoreCase))
                {
                    description = argument.Substring(13).Trim().Trim('"');
                }
                else if (argument.Equals("/selftest", StringComparison.OrdinalIgnoreCase))
                {
                    selfTest = true;
                }
            }

            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 置顶的隐形宿主窗口：以管理员身份运行时，对话框容易被浏览器盖住，
                // 用户看到的现象就是"点了没反应"。
                var owner = new Form();
                owner.Text = "我的相册";
                owner.TopMost = true;
                owner.ShowInTaskbar = false;
                owner.FormBorderStyle = FormBorderStyle.None;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.Size = new Size(1, 1);
                owner.Opacity = 0;

                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = description;
                    dialog.ShowNewFolderButton = false;

                    if (!string.IsNullOrEmpty(initialPath) && Directory.Exists(initialPath))
                    {
                        dialog.SelectedPath = initialPath;
                    }

                    if (selfTest)
                    {
                        // 只把对象和属性都建一遍（不弹窗），用来在打包/测试时验证
                        // "这个 exe 在这台机器上能不能正常工作"
                        string probe = dialog.Description + "|" + dialog.ShowNewFolderButton;
                        owner.Dispose();

                        if (resultPath.Length > 0)
                        {
                            File.WriteAllText(resultPath, "SELFTEST OK " + probe, new UTF8Encoding(false));
                        }

                        Environment.ExitCode = 0;
                        return;
                    }

                    owner.Show();
                    owner.Activate();

                    DialogResult answer;

                    try
                    {
                        answer = dialog.ShowDialog(owner);
                    }
                    finally
                    {
                        try { owner.Close(); owner.Dispose(); } catch { }
                    }

                    if (answer != DialogResult.OK || string.IsNullOrEmpty(dialog.SelectedPath))
                    {
                        Environment.ExitCode = 2;
                        return;
                    }

                    if (resultPath.Length == 0)
                    {
                        Console.Error.WriteLine("缺少 /out 参数");
                        Environment.ExitCode = 1;
                        return;
                    }

                    File.WriteAllText(resultPath, dialog.SelectedPath, new UTF8Encoding(false));
                    Environment.ExitCode = 0;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                Environment.ExitCode = 1;
            }
        }
    }
}