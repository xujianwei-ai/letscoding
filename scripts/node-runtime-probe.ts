import { spawnSync } from 'node:child_process'
import { ordinaryNode } from '../src/runtime.ts'

const executable = ordinaryNode()
if (executable === undefined) throw new Error('No ordinary Node >=24.9 found')
const result = spawnSync(executable, ['-e', 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("select 1"); db.close(); console.log(JSON.stringify({ executable: process.execPath, electron: process.versions.electron ?? null, sqlite: "OK" }))'], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.status ?? 1
