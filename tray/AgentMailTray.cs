// Windows tray host: runs the dashboard with no console and no main window.
// Compiled by scripts/run-windows.ps1 with the csc.exe in .NET Framework, which only supports C# 5.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class AgentMailTray
{
    const string AppName = "Agent Mailbox";
    const string DashboardUrl = "http://127.0.0.1:8788/dashboard";
    const string MutexName = @"Local\AgentMailboxTray";
    const string QuitEventName = @"Local\AgentMailboxTrayQuit";
    const int MaxLogBytes = 1000000;
    const int ShutdownTimeoutMs = 5000;

    static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName, "agent-mailbox.log");
    static readonly object LogLock = new object();

    static StreamWriter log;
    static Process host;
    static NotifyIcon icon;
    static string lastError;
    static bool quitting;
    static int exitCode;

    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--quit")
        {
            using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName)) quit.Set();
            return 0;
        }

        bool first;
        using (new Mutex(true, MutexName, out first))
        {
            if (!first)
            {
                OpenDashboard();
                return 0;
            }
            try
            {
                return Run();
            }
            catch (Exception error)
            {
                Fail(AppName + " could not start.\n\n" + error.Message);
                return 1;
            }
        }
    }

    static int Run()
    {
        // The exe lives in dist/; the icon and tray-host.js are found from the repo root.
        string root = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));
        OpenLog();

        // Hidden control: a marshalling target for callbacks from other threads.
        var ui = new Control();
        ui.CreateControl();
        IntPtr handle = ui.Handle;

        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("Open dashboard", null, delegate { OpenDashboard(); });
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add("Quit", null, delegate { Quit(); });

        icon = new NotifyIcon
        {
            Icon = new Icon(Path.Combine(Path.Combine(root, "assets"), "icon.ico"), SystemInformation.SmallIconSize),
            Text = AppName,
            ContextMenuStrip = menu,
        };
        icon.MouseClick += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) OpenDashboard();
        };

        host = new Process();
        host.StartInfo = new ProcessStartInfo("node", "dist/tray-host.js")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        host.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog(e.Data); };
        host.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            lastError = e.Data;
            WriteLog(e.Data);
        };
        host.EnableRaisingEvents = true;
        host.SynchronizingObject = ui;
        host.Exited += delegate { HostExited(); };
        host.Start();
        host.BeginOutputReadLine();
        host.BeginErrorReadLine();

        var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEventName);
        ThreadPool.RegisterWaitForSingleObject(quitEvent, delegate
        {
            ui.BeginInvoke(new MethodInvoker(Quit));
        }, null, Timeout.Infinite, true);

        icon.Visible = true;
        Application.Run();
        icon.Dispose();
        return exitCode;
    }

    static void OpenDashboard()
    {
        Process.Start(DashboardUrl);
    }

    static void Quit()
    {
        if (quitting) return;
        quitting = true;
        // Closing stdin is the host's signal to shut down.
        host.StandardInput.Close();
        if (!host.WaitForExit(ShutdownTimeoutMs)) host.Kill();
        Application.Exit();
    }

    static void HostExited()
    {
        if (quitting) return;
        // WaitForExit with no timeout also drains the stderr reader, so lastError is complete.
        host.WaitForExit();
        icon.Visible = false;
        exitCode = 1;
        Fail("The dashboard stopped unexpectedly.\n\n" + lastError + "\n\nSee " + LogPath);
        Application.Exit();
    }

    static void Fail(string message)
    {
        WriteLog(message);
        MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    static void OpenLog()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
        var existing = new FileInfo(LogPath);
        bool rotate = existing.Exists && existing.Length > MaxLogBytes;
        if (rotate) File.Copy(LogPath, LogPath + ".1", true);
        var stream = new FileStream(LogPath, rotate ? FileMode.Create : FileMode.Append, FileAccess.Write, FileShare.Read);
        log = new StreamWriter(stream) { AutoFlush = true };
    }

    static void WriteLog(string line)
    {
        if (log == null || string.IsNullOrEmpty(line)) return;
        lock (LogLock) log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line);
    }
}
