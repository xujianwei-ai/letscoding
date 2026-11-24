import type { SdkModelCatalog } from '@deepseek-ai/dsh-sdk-client'

export interface ModelRoute { provider: string, model: string }
export type ModelSettingUpdate = (key: 'provider' | 'model', value: string) => PromiseLike<void>

/** Migrate only models shipped by the earlier development build, never a user's custom provider. */
export async function migrateRemovedBuiltinRoute(
  previous: ModelRoute,
  catalog: SdkModelCatalog,
  update: ModelSettingUpdate,
): Promise<ModelRoute | undefined> {
  if (previous.provider !== 'kimi-coding' || catalog.groups.some(group => group.id === previous.provider)) return undefined
  const fallback = catalog.groups.find(group => group.id === 'deepseek-account')?.models[0]
  if (fallback === undefined) return undefined
  await update('provider', 'deepseek-account')
  await update('model', fallback.id)
  return { provider: 'deepseek-account', model: fallback.id }
}
