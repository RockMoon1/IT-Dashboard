package fsowner

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	advapi32                    = syscall.NewLazyDLL("advapi32.dll")
	netapi32                    = syscall.NewLazyDLL("netapi32.dll")
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procGetNamedSecurityInfoW   = advapi32.NewProc("GetNamedSecurityInfoW")
	procConvertSidToStringSidW  = advapi32.NewProc("ConvertSidToStringSidW")
	procConvertStringSidToSidW  = advapi32.NewProc("ConvertStringSidToSidW")
	procLookupAccountSidW       = advapi32.NewProc("LookupAccountSidW")
	procNetLocalGroupGetMembers = netapi32.NewProc("NetLocalGroupGetMembers")
	procNetApiBufferFree        = netapi32.NewProc("NetApiBufferFree")
	procLocalFree               = kernel32.NewProc("LocalFree")
)

const (
	seFileObject             = 1
	ownerSecurityInformation = 1
	administrators           = "S-1-5-32-544"
	system                   = "S-1-5-18"
	trustedInstaller         = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	maxPreferredLength       = 0xFFFFFFFF
	nerrSuccess              = 0
)

// trusted: owned by SYSTEM, TrustedInstaller, the Administrators group, or one of its members
// (Windows makes the admin who creates a file its owner, so an earlier install's folder is owned
// by that admin's own account).
func trusted(path string) (bool, string, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false, "", err
	}
	var owner, sd uintptr
	if rc, _, _ := procGetNamedSecurityInfoW.Call(uintptr(unsafe.Pointer(p)), seFileObject, ownerSecurityInformation,
		uintptr(unsafe.Pointer(&owner)), 0, 0, 0, uintptr(unsafe.Pointer(&sd))); rc != 0 {
		return false, "", fmt.Errorf("reading the owner of %s: %w", path, syscall.Errno(rc))
	}
	defer procLocalFree.Call(sd)
	sid, err := sidString(owner)
	if err != nil {
		return false, "", err
	}
	switch sid {
	case system, administrators, trustedInstaller:
		return true, sid, nil
	}
	members, err := adminMembers()
	if err != nil {
		return false, sid, err
	}
	for _, m := range members {
		if m == sid {
			return true, sid, nil
		}
	}
	return false, sid, nil
}

func sidString(sid uintptr) (string, error) {
	var s *uint16
	if ok, _, err := procConvertSidToStringSidW.Call(sid, uintptr(unsafe.Pointer(&s))); ok == 0 {
		return "", fmt.Errorf("reading a SID: %w", err)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(s)))
	return utf16z(s), nil
}

// utf16z reads a NUL-terminated UTF-16 string the system allocated, never past its end.
func utf16z(p *uint16) string {
	var out []uint16
	for i := 0; i < 1024; i++ {
		c := *(*uint16)(unsafe.Add(unsafe.Pointer(p), 2*i))
		if c == 0 {
			break
		}
		out = append(out, c)
	}
	return syscall.UTF16ToString(out)
}

// adminMembers lists the SIDs in the local Administrators group, whose name depends on the
// language of Windows, so it is looked up from its well-known SID.
func adminMembers() ([]string, error) {
	sp, _ := syscall.UTF16PtrFromString(administrators)
	var admins uintptr
	if ok, _, err := procConvertStringSidToSidW.Call(uintptr(unsafe.Pointer(sp)), uintptr(unsafe.Pointer(&admins))); ok == 0 {
		return nil, fmt.Errorf("the Administrators SID: %w", err)
	}
	defer procLocalFree.Call(admins)
	name := make([]uint16, 256)
	domain := make([]uint16, 256)
	nameLen, domainLen := uint32(len(name)), uint32(len(domain))
	var use uint32
	if ok, _, err := procLookupAccountSidW.Call(0, admins, uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&nameLen)),
		uintptr(unsafe.Pointer(&domain[0])), uintptr(unsafe.Pointer(&domainLen)), uintptr(unsafe.Pointer(&use))); ok == 0 {
		return nil, fmt.Errorf("the Administrators group's name: %w", err)
	}
	var buf *uintptr // LOCALGROUP_MEMBERS_INFO_0: one PSID per member
	var read, total uint32
	var resume uintptr
	rc, _, _ := procNetLocalGroupGetMembers.Call(0, uintptr(unsafe.Pointer(&name[0])), 0, uintptr(unsafe.Pointer(&buf)),
		maxPreferredLength, uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&resume)))
	if buf != nil {
		defer procNetApiBufferFree.Call(uintptr(unsafe.Pointer(buf)))
	}
	if rc != nerrSuccess {
		return nil, fmt.Errorf("listing the Administrators group: %w", syscall.Errno(rc))
	}
	var out []string
	for _, m := range unsafe.Slice(buf, read) {
		if s, err := sidString(m); err == nil {
			out = append(out, s)
		}
	}
	return out, nil
}
