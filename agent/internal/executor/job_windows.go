package executor

import (
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x2000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
)

// Layouts of JOBOBJECT_BASIC_LIMIT_INFORMATION and JOBOBJECT_EXTENDED_LIMIT_INFORMATION for
// 64-bit Windows (the agent is built for amd64 and arm64 only).
type basicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type extendedLimitInformation struct {
	BasicLimitInformation basicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// job is a Job Object that kills every process in it when it is closed. When Windows refuses
// one (very old systems), runs fall back to killing powershell.exe alone.
type job struct {
	mu sync.Mutex
	h  syscall.Handle
}

func newJob() *job {
	h, _, _ := procCreateJobObjectW.Call(0, 0)
	if h == 0 {
		return &job{}
	}
	info := extendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, _ := procSetInformationJobObject.Call(h, jobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(h))
		return &job{}
	}
	return &job{h: syscall.Handle(h)}
}

// assign puts the started process in the job. Children it starts afterwards inherit the job.
func (j *job) assign(pid int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.h == 0 {
		return
	}
	p, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(p)
	procAssignProcessToJobObject.Call(uintptr(j.h), uintptr(p))
}

func (j *job) terminate() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.h != 0 {
		procTerminateJobObject.Call(uintptr(j.h), 1)
	}
}

// close releases the job; anything still running in it (a grandchild that outlived the script)
// is killed by Windows because of KILL_ON_JOB_CLOSE.
func (j *job) close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.h != 0 {
		syscall.CloseHandle(j.h)
		j.h = 0
	}
}
