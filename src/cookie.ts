import { Platform, Plugin } from "obsidian";
import { getSettings, saveSettings } from "./settings";
import { session } from '@electron/remote';

export const prepareCommunication = async (plugin: Plugin) => {

  const settings = await getSettings(plugin)
  if (Platform.isDesktopApp) {    
    await session.defaultSession.cookies.set({ url: "https://www.peerdraft.app", "name": "oid", "value": settings.oid, "domain": "www.peerdraft.app", "path": "/", "secure": true, "httpOnly": true, "sameSite": "no_restriction" })
  }
  else if (Platform.isMobileApp) {
    const signalingURL = new URL(settings.signaling)
    signalingURL.searchParams.append('oid', settings.oid)
    settings.signaling = signalingURL.toString()
    await saveSettings(settings, plugin)
  }
}