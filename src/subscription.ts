import { Plugin, requestUrl } from "obsidian"
import { getSettings, saveSettings } from "./settings"
import PeerdraftPlugin from "./main"

export const refreshSubscriptionData = async (plugin: PeerdraftPlugin) => {
  const settings = await getSettings(plugin)
  const url = new URL(settings.subscriptionAPI)
  url.searchParams.set('oid', settings.oid)
  const data = await requestUrl(url.toString()).json
  if (data) {
    if(data.plan) {
      settings.plan = data.plan
    }
    if(data.usage) {
      settings.duration = data.usage
    }
    await saveSettings(settings, plugin)
  }
}

