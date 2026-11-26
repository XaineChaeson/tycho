// ptybridge: tycho's login helper on a Windows host (docs/design/native-login.md §四). It runs
// one command inside a pseudoconsole (ConPTY) and relays raw bytes: its own stdin -> the
// command's terminal input, the terminal's output -> its own stdout. The service has no
// terminal, and `claude setup-token` will not run without one.
//
// Usage: ptybridge <deadline> <parent pid> <cols> <rows> <command line>
//   deadline   milliseconds since 1970-01-01 UTC; at that moment the bridge ends itself
//   parent pid the process that holds this bridge; when it is gone the bridge ends itself
//
// The command runs in a job object that ends everything in it when its last handle closes,
// and that handle is this process's. So however the bridge ends (the command exits, the
// parent goes, the deadline passes, its stdin closes, or it is terminated), the command and
// everything it started end with it. The bridge never waits for anyone to clean up after it.
//
// It is not a remote terminal: the service starts it only with the fixed commands of a login
// session and of its own self-check.
//
// Written in C# 5 so both csc v4.0.30319 and PowerShell 5.1 Add-Type compile it.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class PtyBridge
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr sa, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr proc, uint code);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr h, out int code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint SYNCHRONIZE = 0x00100000;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    // The exit codes the service reads: the command's own, or one of these.
    const int USAGE = 2, SETUP_FAILED = 125, PARENT_GONE = 124, DEADLINE = 123;

    static IntPtr job = IntPtr.Zero;

    static int Fail(string what)
    {
        Console.Error.WriteLine("ptybridge: " + what + " failed, win32 error " + Marshal.GetLastWin32Error());
        return SETUP_FAILED;
    }

    // Ends the bridge now. The job's handle closes with the process, and the job ends the
    // command's whole tree with it; TerminateJob-equivalent behaviour without trusting any
    // thread of ours to still run.
    static void End(int code, string why)
    {
        try { Console.Error.WriteLine("ptybridge: " + why); Console.Error.Flush(); } catch (Exception) { }
        Environment.Exit(code);
    }

    static void Watch(ThreadStart body)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Start();
    }

    public static int Run(string[] args)
    {
        return Run(args, delegate { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }, Thread.Sleep);
    }

    // The wait is separate from the clock so a caller can supply its own timer.
    internal static int Run(string[] args, Func<long> now, Action<int> wait)
    {
        if (args.Length < 5) { Console.Error.WriteLine("usage: ptybridge <deadline> <parent pid> <cols> <rows> <command line>"); return USAGE; }
        long deadline; int parentPid; short cols, rows;
        if (!long.TryParse(args[0], out deadline) || !int.TryParse(args[1], out parentPid)
            || !short.TryParse(args[2], out cols) || !short.TryParse(args[3], out rows))
        {
            Console.Error.WriteLine("ptybridge: bad arguments");
            return USAGE;
        }
        string cmdLine = string.Join(" ", args, 4, args.Length - 4);
        long selfCreation, selfExit, selfKernel, selfUser;
        if (GetProcessTimes(GetCurrentProcess(), out selfCreation, out selfExit, out selfKernel, out selfUser))
            Console.Error.WriteLine("ptybridge: started " + selfCreation);

        // The parent first: a bridge whose parent is already gone has nobody to serve.
        IntPtr parent = OpenProcess(SYNCHRONIZE, false, parentPid);
        if (parent == IntPtr.Zero) return Fail("OpenProcess(parent)");
        Watch(delegate ()
        {
            WaitForSingleObject(parent, 0xFFFFFFFF);
            End(PARENT_GONE, "parent gone");
        });
        long left = deadline - now();
        if (left <= 0) { Console.Error.WriteLine("ptybridge: deadline passed"); return DEADLINE; }
        Watch(delegate ()
        {
            long rest = left;
            while (rest > 0) { int step = (int)Math.Min(rest, int.MaxValue); wait(step); rest -= step; }
            End(DEADLINE, "deadline passed");
        });

        // The job comes before the command, so there is no moment the command runs outside it.
        job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) return Fail("CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        jl.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref jl, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("SetInformationJobObject");

        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(in)");
        if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) return Fail("CreatePipe(out)");
        IntPtr hPC;
        int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inRead, outWrite, 0, out hPC);
        if (hr != 0) { Console.Error.WriteLine("ptybridge: CreatePseudoConsole hr=0x" + hr.ToString("X8")); return SETUP_FAILED; }
        inRead.Dispose(); outWrite.Dispose(); // the pseudoconsole holds its own copies

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) return Fail("InitializeProcThreadAttributeList");
        if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            return Fail("UpdateProcThreadAttribute");

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // Null std handles + STARTF_USESTDHANDLES: otherwise a child of a process whose own
        // stdio is redirected can inherit those pipes instead of attaching to the pseudoconsole.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, new System.Text.StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
            return Fail("CreateProcess");
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            // Suspended, so it has run nothing: ended here, it never runs outside the job.
            TerminateProcess(pi.hProcess, SETUP_FAILED);
            return Fail("AssignProcessToJobObject");
        }
        long creation, exit, kernel, user;
        bool hasCreation = GetProcessTimes(pi.hProcess, out creation, out exit, out kernel, out user);
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        Console.Error.WriteLine("ptybridge: child pid " + pi.dwProcessId + (hasCreation ? " started " + creation : ""));
        Console.Error.Flush();

        Stream stdout = Console.OpenStandardOutput();
        FileStream ptyOut = new FileStream(outRead, FileAccess.Read, 1, false);
        Thread reader = new Thread(delegate ()
        {
            byte[] buf = new byte[16384];
            try { int n; while ((n = ptyOut.Read(buf, 0, buf.Length)) > 0) { stdout.Write(buf, 0, n); stdout.Flush(); } }
            catch (IOException) { }
        });
        reader.IsBackground = true; reader.Start();

        // Our stdin is the channel to the parent: its end is the parent letting go, whether it
        // closed the pipe or died. Either way nobody is left to talk to the command.
        Stream stdin = Console.OpenStandardInput();
        FileStream ptyIn = new FileStream(inWrite, FileAccess.Write, 1, false);
        Watch(delegate ()
        {
            byte[] buf = new byte[4096];
            try { int n; while ((n = stdin.Read(buf, 0, buf.Length)) > 0) { ptyIn.Write(buf, 0, n); ptyIn.Flush(); } }
            catch (IOException) { }
            End(PARENT_GONE, "input closed");
        });

        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        int code; GetExitCodeProcess(pi.hProcess, out code);
        // Closing the pseudoconsole flushes the last frame and ends the output pipe.
        ClosePseudoConsole(hPC);
        reader.Join(2000);
        DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList);
        CloseHandle(pi.hProcess);
        stdout.Flush();
        return code;
    }

    public static int Main(string[] args)
    {
        // Every way out goes through Exit, which closes the job's handle with the process.
        Environment.Exit(Run(args));
        return 0;
    }
}
