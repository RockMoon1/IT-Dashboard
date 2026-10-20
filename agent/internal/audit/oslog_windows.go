package audit

import (
	"syscall"
	"unsafe"
)

var (
	advapi32                  = syscall.NewLazyDLL("advapi32.dll")
	procRegisterEventSourceW  = advapi32.NewProc("RegisterEventSourceW")
	procReportEventW          = advapi32.NewProc("ReportEventW")
	procDeregisterEventSource = advapi32.NewProc("DeregisterEventSource")
)

const eventlogInformationType = 0x0004

// osLog writes to the Windows Application log under the source "ARH Agent". Without a message
// file Event Viewer prefixes the text with a note that the description is missing; the text
// itself is still recorded, and clearing the log leaves event 104.
type osLog struct{ h uintptr }

func openOSLog() osLog {
	name, err := syscall.UTF16PtrFromString("ARH Agent")
	if err != nil {
		return osLog{}
	}
	h, _, _ := procRegisterEventSourceW.Call(0, uintptr(unsafe.Pointer(name)))
	return osLog{h: h}
}

func (o osLog) write(event string, msg string) {
	if o.h == 0 {
		return
	}
	p, err := syscall.UTF16PtrFromString(msg)
	if err != nil {
		return
	}
	id := uint32(100)
	if event == "outcome" {
		id = 101
	}
	strs := []*uint16{p}
	procReportEventW.Call(o.h, eventlogInformationType, 0, uintptr(id), 0, 1, 0, uintptr(unsafe.Pointer(&strs[0])), 0)
}

var _ = procDeregisterEventSource
