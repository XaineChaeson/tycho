// procinfo: one program, three questions about this machine's processes, so that a Windows
// host does not start a PowerShell and a WMI query for every answer.
//
//   procinfo starts <pid>...   when each process began, and whether it is still there
//   procinfo table             every process, with its parent and when it began
//   procinfo tagged            every process whose command line carries the marker
//
// The marker of `tagged` travels in the environment (TYCHO_PROCINFO_MARKER) and never on
// this program's command line: this program's own command line would otherwise carry it,
// and a query of the same marker running beside it would report it as a marked process.
//
// Line output, one record a line. A process whose beginning cannot be read is "unknown"
// with why: a pid that has ended keeps its object until its parent collects it, so a start
// time alone does not prove the process is still there (and its exit code is not asked:
// a process may exit with 259, which is what "still active" would mean to a naive check).
//
// Usage is by service/procinfo.ts only, which compiles this once and falls back to the
// PowerShell queries of old if it will not build or run. Written in C# 5 so csc
// v4.0.30319 (the one .NET Framework 4 puts on every Windows) compiles it, and so
// PowerShell 5.1 could too.
using System;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcInfo
{
    // OpenProcess rights: ask about the process, and wait on it to see whether it is gone.
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_TIMEOUT = 0x00000102;
    const uint WAIT_OBJECT_0 = 0x00000000;
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const int ERROR_NO_MORE_FILES = 18;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    const int USAGE = 2, FAILED = 1;
    const string MARKER_VARIABLE = "TYCHO_PROCINFO_MARKER";

    // When this process began, or null with why it cannot be said. The wait on the same
    // handle is what tells a live process from one that has ended but is not collected yet.
    static string StartOf(int pid, out string why)
    {
        why = null;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid);
        if (handle == IntPtr.Zero) { why = "open " + Marshal.GetLastWin32Error(); return null; }
        try
        {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) { why = "times " + Marshal.GetLastWin32Error(); return null; }
            uint waited = WaitForSingleObject(handle, 0);
            if (waited == WAIT_OBJECT_0) { why = "exited"; return null; }
            if (waited != WAIT_TIMEOUT) { why = "wait " + Marshal.GetLastWin32Error(); return null; }
            return creation.ToString();
        }
        finally { CloseHandle(handle); }
    }

    static void Say(string line) { Console.Out.Write(line); Console.Out.Write("\n"); }

    static int Starts(string[] pids)
    {
        uint self = GetCurrentProcessId();
        foreach (string text in pids)
        {
            int pid;
            if (!int.TryParse(text, out pid)) { Console.Error.WriteLine("procinfo: not a pid: " + text); return USAGE; }
            if ((uint)pid == self) { Say(pid + " unknown self"); continue; }
            string why;
            string start = StartOf(pid, out why);
            Say(start != null ? pid + " start " + start : pid + " unknown " + why);
        }
        return 0;
    }

    // The whole table, held until it is written: a half table that fails midway is not an
    // answer, so it must never reach the caller's eye as one.
    static int Table()
    {
        uint self = GetCurrentProcessId();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) { Console.Error.WriteLine("procinfo: snapshot failed, win32 error " + Marshal.GetLastWin32Error()); return FAILED; }
        StringBuilder rows = new StringBuilder();
        try
        {
            PROCESSENTRY32 entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref entry))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ERROR_NO_MORE_FILES) { Console.Error.WriteLine("procinfo: enumeration failed, win32 error " + error); return FAILED; }
                return 0;
            }
            do
            {
                if (entry.th32ProcessID == self) continue;
                string why;
                string start = StartOf((int)entry.th32ProcessID, out why);
                rows.Append(entry.th32ProcessID).Append(' ').Append(entry.th32ParentProcessID).Append(' ')
                    .Append(start != null ? start : "unknown").Append('\n');
            }
            while (Process32Next(snapshot, ref entry));
            int last = Marshal.GetLastWin32Error();
            if (last != ERROR_NO_MORE_FILES) { Console.Error.WriteLine("procinfo: enumeration failed midway, win32 error " + last); return FAILED; }
        }
        finally { CloseHandle(snapshot); }
        Console.Out.Write(rows.ToString());
        return 0;
    }

    // Everything whose command line carries the marker, as WMI has the command lines. A WMI
    // that will not answer is a failure, never an empty set: "nothing is there" is an answer
    // the caller acts on.
    static int Tagged()
    {
        string marker = Environment.GetEnvironmentVariable(MARKER_VARIABLE);
        if (marker == null || marker.Length == 0) { Console.Error.WriteLine("procinfo: no marker in " + MARKER_VARIABLE); return USAGE; }
        uint self = GetCurrentProcessId();
        List<uint> found = new List<uint>();
        using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process"))
        using (ManagementObjectCollection rows = searcher.Get())
        {
            foreach (ManagementBaseObject row in rows)
            {
                object pid = row["ProcessId"];
                object line = row["CommandLine"];
                if (pid == null || line == null) continue;
                uint value = Convert.ToUInt32(pid);
                if (value == self) continue;
                if (line.ToString().Contains(marker)) found.Add(value);
            }
        }
        foreach (uint pid in found) Say(pid.ToString());
        return 0;
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1) { Console.Error.WriteLine("usage: procinfo starts <pid>... | table | tagged"); return USAGE; }
            if (args[0] == "starts")
            {
                if (args.Length < 2) { Console.Error.WriteLine("usage: procinfo starts <pid>..."); return USAGE; }
                string[] pids = new string[args.Length - 1];
                Array.Copy(args, 1, pids, 0, pids.Length);
                return Starts(pids);
            }
            if (args[0] == "table") return Table();
            if (args[0] == "tagged")
            {
                if (args.Length != 1) { Console.Error.WriteLine("usage: procinfo tagged"); return USAGE; }
                return Tagged();
            }
            Console.Error.WriteLine("procinfo: unknown command: " + args[0]);
            return USAGE;
        }
        catch (Exception failure)
        {
            // WMI refused, or anything else: the caller falls back, and never reads a partial
            // answer as a whole one.
            Console.Error.WriteLine("procinfo: " + failure.Message);
            return FAILED;
        }
    }
}
