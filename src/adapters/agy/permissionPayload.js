export function agyPermissionPayload(tool, cwd) {
  const input = tool.args || tool.rawInput || {};
  const name = String(tool.name || tool.kind || 'unknown').toLowerCase();
  const names = { read_file: 'Read', view_file: 'Read', read: 'Read', write_file: 'Write', write_to_file: 'Write',
    edit: 'Edit', replace_file_content: 'Edit', multi_replace_file_content: 'Edit',
    bash: 'Bash', run_command: 'Bash', execute: 'Bash', list_dir: 'LS', grep_search: 'Grep', find_by_name: 'Glob' };
  const command = input.CommandLine || input.command || input.command_line || '';
  const file = input.Path || input.AbsolutePath || input.TargetFile || input.path || input.file_path || tool.locations?.[0]?.path;
  return { tool: names[name] || name, display_name: tool.name || tool.title || name,
    native_tool: name, tool_input: { ...input, ...(file ? { file_path: file } : {}), ...(command ? { command } : {}) },
    command, cwd, remember_allowed: false };
}
