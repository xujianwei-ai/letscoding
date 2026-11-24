import { defineConfig } from 'tsdown'

/** Publish every relative runtime module, not only the public package index. */
export default defineConfig({ entry: ['lib/types/**/*.js'] })
