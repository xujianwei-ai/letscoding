import { defineConfig } from 'tsdown'

/** Keep the transport module referenced by the public protocol index. */
export default defineConfig({ entry: ['lib/types/**/*.js'] })
