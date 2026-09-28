// Windows Script Host JScript, executed by wscript.exe rather than Node.
// The GUI host applies SW_HIDE before creating PowerShell. PowerShell's own
// -WindowStyle flag is parsed too late to prevent a Windows Terminal window.
try {
  var shell = new ActiveXObject("WScript.Shell");
  if (WScript.Arguments.length === 1 && WScript.Arguments.Item(0) === "--check") {
    WScript.Quit(0);
  }
  if (WScript.Arguments.length !== 2 || WScript.Arguments.Item(0) !== "--encoded-command") {
    throw new Error("Expected an encoded service command.");
  }
  var encoded = WScript.Arguments.Item(1);
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error("Invalid encoded service command.");
  }
  var root = shell.ExpandEnvironmentStrings("%SystemRoot%");
  var command = '"' + root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"'
    + " -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded;
  WScript.Quit(shell.Run(command, 0, true));
} catch (error) {
  WScript.Echo("OriginRouter service launcher: " + error.message);
  WScript.Quit(1);
}
