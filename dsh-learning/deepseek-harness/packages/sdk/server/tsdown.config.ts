import { defineConfig } from 'tsdown'

/** The plugin index imports request handlers at runtime; include every server module. */
export default defineConfig({ entry: ['lib/types/**/*.js'] })
