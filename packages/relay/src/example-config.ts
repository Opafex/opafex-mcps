/** What `opafex-relay init` writes. Nothing is enabled: both lists are empty. */
export const EXAMPLE_CONFIG = `// opafex relay configuration
//
// The relay runs ONLY what this file lists. Nothing is enabled yet: "commands" and
// "mcpServers" are empty. Copy an example from the comments into a list to allow it.
//
// Commands you allow here run on this machine, as you, under your authority.
// Each one is a program and a fixed list of arguments. A {param} in an argument is
// filled with a value the agent sends, as ONE argument, never through a shell, and only
// if the whole value matches the param's pattern. Make the patterns as narrow as you can.
//
// After editing, run "opafex-relay check" to see what the relay would offer.
// A running relay picks up changes to this file by itself.
{
  // Where your opafex account lives.
  "platformUrl": "https://app.opafex.com",

  // The name this machine shows under in opafex. Defaults to the computer's name.
  // "machineName": "my-laptop",

  // The relay key. Make one in opafex Settings, then EITHER set the OPAFEX_RELAY_KEY
  // environment variable OR save the key in a file only you can read and name it here:
  // "keyFile": "~/.opafex/relay.key",

  "commands": [
    // Example: "git status" in one folder under ~/projects.
    // {
    //   "id": "git_status",
    //   "description": "Show git status for a project folder",
    //   "executable": "git",
    //   "args": ["-C", "{repo}", "status", "--short"],
    //   "cwd": "~/projects",
    //   "timeoutSeconds": 30,
    //   "params": [
    //     { "name": "repo", "description": "a folder name under ~/projects",
    //       "pattern": "[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}" }
    //   ]
    // }
  ],

  "mcpServers": [
    // Example: a local stdio MCP server. Give the program and its script directly:
    // on Windows "npx" is a batch file, which the relay will not run, so use node.exe
    // and the path to the package's script.
    // {
    //   "id": "files",
    //   "command": "node",
    //   "args": ["/path/to/server/dist/index.js", "/a/folder/it/may/read"],
    //   "tools": ["read_file", "list_directory"]
    // }
  ]
}
`;
