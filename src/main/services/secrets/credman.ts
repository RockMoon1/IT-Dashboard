import { runPowerShell } from '../remoting/powershell.ts'
import type { RunResult } from '../remoting/types.ts'
import type { SecretStore } from './store.ts'

/**
 * Windows Credential Manager (generic credentials, LOCAL_MACHINE persistence) through a short
 * P/Invoke shim compiled by PowerShell's Add-Type. Values travel to the child process in its
 * environment block, never on the command line, and come back base64-encoded on stdout.
 *
 * Blob limit: CRED_MAX_CREDENTIAL_BLOB_SIZE is 2560 bytes. The host TLS key (PKCS#8 PEM, ~240
 * bytes) fits comfortably; larger values are rejected before any call.
 */

export const CRED_TARGET_PREFIX = 'ARH IT Dashboard/'
export const CRED_MAX_BLOB = 2560

export const CREDMAN_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ArhCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);

  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) { return null; }
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) { Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize); }
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }

  public static void Write(string target, string user, string base64) {
    byte[] b = Convert.FromBase64String(base64);
    IntPtr blob = Marshal.AllocHGlobal(Math.Max(b.Length, 1));
    try {
      Marshal.Copy(b, 0, blob, b.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1;
      c.TargetName = target;
      c.UserName = user;
      c.Comment = "ARH IT Dashboard";
      c.CredentialBlob = blob;
      c.CredentialBlobSize = (uint)b.Length;
      c.Persist = 2;
      if (!CredWriteW(ref c, 0)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    } finally { Marshal.FreeHGlobal(blob); }
  }

  public static bool Delete(string target) {
    if (CredDeleteW(target, 1, 0)) { return true; }
    int e = Marshal.GetLastWin32Error();
    if (e == 1168) { return false; }
    throw new System.ComponentModel.Win32Exception(e);
  }
}
"@
$op = $env:ARH_CRED_OP
$target = $env:ARH_CRED_TARGET
switch ($op) {
  'read' {
    $r = [ArhCred]::Read($target)
    if ($null -eq $r) { Write-Output 'MISSING' } else { Write-Output ('B64:' + $r) }
  }
  'write' {
    [ArhCred]::Write($target, 'ARH IT Dashboard', $env:ARH_CRED_VALUE_B64)
    Write-Output 'OK'
  }
  'delete' {
    if ([ArhCred]::Delete($target)) { Write-Output 'DELETED' } else { Write-Output 'MISSING' }
  }
  default { throw ('unknown op ' + $op) }
}
`

export type PowerShellRunner = (
  script: string,
  opts: { env: Record<string, string>; timeoutMs: number }
) => Promise<RunResult>

export class CredentialManagerStore implements SecretStore {
  private run: PowerShellRunner

  constructor(run: PowerShellRunner = (script, opts) => runPowerShell(script, opts)) {
    this.run = run
  }

  private async call(env: Record<string, string>): Promise<string> {
    const r = await this.run(CREDMAN_SCRIPT, { env, timeoutMs: 30_000 })
    const out = r.stdout.trim().split(/\r?\n/).pop() ?? ''
    if (r.exitCode !== 0 || !out) {
      throw new Error(
        `Credential Manager call failed: ${r.stderr.trim() || out || `exit ${r.exitCode}`}`
      )
    }
    return out
  }

  async get(name: string): Promise<string | null> {
    const out = await this.call({ ARH_CRED_OP: 'read', ARH_CRED_TARGET: CRED_TARGET_PREFIX + name })
    if (out === 'MISSING') return null
    if (!out.startsWith('B64:')) throw new Error(`unexpected Credential Manager reply: ${out}`)
    return Buffer.from(out.slice(4), 'base64').toString('utf8')
  }

  async set(name: string, value: string): Promise<void> {
    const bytes = Buffer.from(value, 'utf8')
    if (bytes.length > CRED_MAX_BLOB) {
      throw new Error(
        `secret "${name}" is ${bytes.length} bytes; Credential Manager blobs are limited to ${CRED_MAX_BLOB}`
      )
    }
    const out = await this.call({
      ARH_CRED_OP: 'write',
      ARH_CRED_TARGET: CRED_TARGET_PREFIX + name,
      ARH_CRED_VALUE_B64: bytes.toString('base64')
    })
    if (out !== 'OK') throw new Error(`unexpected Credential Manager reply: ${out}`)
  }

  async delete(name: string): Promise<boolean> {
    const out = await this.call({
      ARH_CRED_OP: 'delete',
      ARH_CRED_TARGET: CRED_TARGET_PREFIX + name
    })
    return out === 'DELETED'
  }

  describe(): string {
    return 'Windows Credential Manager (generic credential, local machine persistence)'
  }
}
