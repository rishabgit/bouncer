"""Read-only, current macOS listener-tree memory; stdin EOF stops this sampler.

Each complete aggregate is one bounded sequential snapshot, never a sum of
per-process lifetime peaks. No executable paths or command lines are collected.
"""
import argparse
import ctypes
import errno
import json
import select
import subprocess
import sys
import time


class RUsageV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins",
        "wired_size", "resident_size", "phys_footprint", "proc_start_abstime",
        "proc_exit_abstime", "child_user_time", "child_system_time",
        "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
        "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten",
        "cpu_time_qos_default", "cpu_time_qos_maintenance", "cpu_time_qos_background",
        "cpu_time_qos_utility", "cpu_time_qos_legacy", "cpu_time_qos_user_initiated",
        "cpu_time_qos_user_interactive", "billed_system_time", "serviced_system_time",
        "logical_writes", "lifetime_max_phys_footprint", "instructions", "cycles",
        "billed_energy", "serviced_energy", "interval_max_phys_footprint", "runnable_time",
    )]


assert ctypes.sizeof(RUsageV4) == 296


class MemorySampler:
    def __init__(self, port):
        self.port, self.root_pid, self.root_start = port, None, None
        if sys.platform != "darwin":
            raise OSError(errno.ENOSYS, "macOS required")
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listchildpids.restype = ctypes.c_int
        self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.lib.proc_pid_rusage.restype = ctypes.c_int

    def usage(self, pid, expected=None):
        value = RUsageV4()
        ctypes.set_errno(0)
        if self.lib.proc_pid_rusage(pid, 4, ctypes.byref(value)) != 0:
            raise OSError(ctypes.get_errno() or errno.EIO, "memory unavailable")
        if not value.proc_start_abstime or (expected is not None and value.proc_start_abstime != expected):
            raise OSError(errno.ESRCH, "process identity changed")
        return value

    def children(self, pid):
        ctypes.set_errno(0)
        estimate = self.lib.proc_listchildpids(pid, None, 0)
        if estimate < 0 or (estimate == 0 and ctypes.get_errno()):
            raise OSError(ctypes.get_errno() or errno.EIO, "child discovery unavailable")
        capacity = max(estimate + 64, 128)
        for _ in range(3):
            buffer = (ctypes.c_int * capacity)()
            ctypes.set_errno(0)
            count = self.lib.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
            if count < 0 or (count == 0 and ctypes.get_errno()):
                raise OSError(ctypes.get_errno() or errno.EIO, "child discovery unavailable")
            if count < capacity:
                return sorted({int(child) for child in buffer[:count] if child > 0})
            capacity *= 2
        raise OSError(errno.EOVERFLOW, "child discovery raced")

    def listener(self):
        result = subprocess.run(
            ["/usr/sbin/lsof", "-nP", "-t", f"-iTCP:{self.port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=1, check=False,
        )
        lines = result.stdout.splitlines()
        if result.returncode != 0 or not lines or any(not line.isdigit() for line in lines):
            raise OSError(errno.EACCES, "listener discovery unavailable")
        pids = {int(line) for line in lines}
        if len(pids) != 1 or min(pids) <= 0:
            raise OSError(errno.EBUSY, "listener is not unique")
        pid = pids.pop()
        start = int(self.usage(pid).proc_start_abstime)
        if self.root_pid is None:
            self.root_pid, self.root_start = pid, start
        if (pid, start) != (self.root_pid, self.root_start):
            raise OSError(errno.ESRCH, "bound listener changed")

    def tree(self):
        parents = {self.root_pid: None}
        starts = {self.root_pid: self.root_start}
        queue = [self.root_pid]
        for parent in queue:
            self.usage(parent, starts[parent])
            children = self.children(parent)
            self.usage(parent, starts[parent])
            for child in children:
                if child in parents:
                    raise OSError(errno.ESRCH, "process tree changed")
                start = int(self.usage(child).proc_start_abstime)
                # A census PID is only a candidate until membership and both
                # process identities are bracketed again after binding it.
                if child not in self.children(parent):
                    raise OSError(errno.ESRCH, "child relationship changed")
                self.usage(parent, starts[parent])
                self.usage(child, start)
                parents[child], starts[child] = parent, start
                queue.append(child)
        return parents, starts

    def snapshot(self):
        sample = {"time": time.time_ns() / 1_000_000, "complete": False,
                  "rootPid": self.root_pid, "processes": [],
                  "footprintBytes": None, "rssBytes": None}
        try:
            self.listener()
            parents, starts = self.tree()
            processes = []
            for pid in sorted(parents):
                value = self.usage(pid, starts[pid])
                processes.append({"pid": pid, "parentPid": parents[pid],
                                  "startIdentity": str(starts[pid]),
                                  "footprintBytes": int(value.phys_footprint),
                                  "rssBytes": int(value.resident_size)})
            # A changed/exited/new descendant invalidates the whole aggregate.
            if self.tree() != (parents, starts):
                raise OSError(errno.ESRCH, "process tree changed during snapshot")
            footprint = sum(value["footprintBytes"] for value in processes)
            rss = sum(value["rssBytes"] for value in processes)
            if footprint <= 0 or rss <= 0:
                raise OSError(errno.EIO, "empty memory reading")
            sample.update(complete=True, processes=processes, footprintBytes=footprint, rssBytes=rss)
        except (OSError, subprocess.SubprocessError) as error:
            kind = "permission_denied" if isinstance(error, OSError) and error.errno in (errno.EPERM, errno.EACCES) else "incomplete_snapshot"
            sample["error"] = kind
        sample["rootPid"] = self.root_pid
        return sample


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, choices=(9931, 11434), required=True)
    parser.add_argument("--interval", type=float, default=0.2)
    args = parser.parse_args()
    if not 0.05 <= args.interval <= 10:
        parser.error("interval must be between .05 and 10 seconds")
    try:
        sampler = MemorySampler(args.port)
    except (OSError, AttributeError):
        print(json.dumps({"time": time.time_ns() / 1_000_000, "complete": False,
                          "rootPid": None, "processes": [], "footprintBytes": None,
                          "rssBytes": None, "error": "macos_libproc_unavailable"}), flush=True)
        return
    while True:
        if select.select([sys.stdin], [], [], 0)[0] and not sys.stdin.buffer.read1(1):
            return
        started = time.monotonic()
        print(json.dumps(sampler.snapshot()), flush=True)
        remaining = max(0, args.interval - (time.monotonic() - started))
        if select.select([sys.stdin], [], [], remaining)[0] and not sys.stdin.buffer.read1(1):
            return


if __name__ == "__main__":
    main()
