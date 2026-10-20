//go:build !windows

package audit

import "log/syslog"

type osLog struct{ w *syslog.Writer }

func openOSLog() osLog {
	w, err := syslog.New(syslog.LOG_NOTICE|syslog.LOG_AUTH, "arh-agent")
	if err != nil {
		return osLog{}
	}
	return osLog{w: w}
}

func (o osLog) write(_ string, msg string) {
	if o.w != nil {
		_ = o.w.Notice(msg)
	}
}
