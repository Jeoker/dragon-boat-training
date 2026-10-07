import { spawn } from "node:child_process";

// One helper per Node process. Every request checks current ACLs; no result cache.
const script = `$ErrorActionPreference='Stop';
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  $allowed=@($sid,'S-1-5-18','S-1-5-32-544');
  $sensitive=[System.Security.AccessControl.FileSystemRights]::ReadData -bor
    [System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership;
  while($null -ne ($p=[Console]::ReadLine())){
    try {
      $acl=Get-Acl -LiteralPath $p;
      $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      $ok=$owner -in $allowed;
      foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
        if($r.AccessControlType -eq 'Allow' -and (($r.FileSystemRights -band $sensitive) -ne 0) -and
          $r.IdentityReference.Value -notin $allowed){$ok=$false}
      }; if($ok){[Console]::WriteLine('PRIVATE')}else{[Console]::WriteLine('UNCONFIRMED')}
    } catch {[Console]::WriteLine('UNCONFIRMED')}
  }`;
let helper;
const failure = () => new Error("PRIVATE_HOST_PATH_UNCONFIRMED");

function start() {
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PSModulePath: undefined }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const state = { child, pending: [], buffer: "", closed: false };
  const stop = () => {
    if (state.closed) return; state.closed = true;
    for (const request of state.pending.splice(0)) { clearTimeout(request.timer); request.reject(failure()); }
    child.kill(); if (helper === state) helper = undefined;
  };
  state.stop = stop;
  child.on("error", stop); child.on("exit", stop); child.stdin.on("error", stop);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    state.buffer += chunk;
    if (state.buffer.length > 4096) return stop();
    while (state.buffer.includes("\n")) {
      const boundary = state.buffer.indexOf("\n"), line = state.buffer.slice(0, boundary).trim();
      state.buffer = state.buffer.slice(boundary + 1);
      const request = state.pending.shift();
      if (!request || !["PRIVATE", "UNCONFIRMED"].includes(line)) return stop();
      clearTimeout(request.timer);
      if (line === "PRIVATE") request.resolve(); else request.reject(failure());
    }
  });
  // Pending requests have a referenced timeout. An idle helper does not keep Node alive.
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.();
  return state;
}

export function checkWindowsAcl(path) {
  if (typeof path !== "string" || /[\r\n\0]/u.test(path)) return Promise.reject(failure());
  helper ??= start(); const state = helper;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => state.stop(), 10_000);
    state.pending.push({ resolve, reject, timer });
    state.child.stdin.write(path + "\n", error => { if (error) state.stop(); });
  });
}
export function closeWindowsAcl() { helper?.stop(); }
process.once("exit", closeWindowsAcl);
