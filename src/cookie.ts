import { Platform, Plugin } from "obsidian";
import { session } from '@electron/remote';
import PeerdraftPlugin from "./main";

export const prepareCommunication = async (plugin: PeerdraftPlugin) => {

  if (Platform.isDesktopApp) {    
    await session.defaultSession.cookies.set({ url: "https://www.peerdraft.app", "name": "oid", "value": plugin.settings.oid, "domain": "www.peerdraft.app", "path": "/", "secure": true, "httpOnly": true, "sameSite": "no_restriction" })
    await session.defaultSession.cookies.set({ url: "http://localhost:5173", "name": "oid", "value": plugin.settings.oid, "domain": "localhost", "path": "/", "secure": true, "httpOnly": true, "sameSite": "no_restriction" })
  }
  else if (Platform.isMobileApp) {
    const signalingURL = new URL(plugin.settings.signaling)
    signalingURL.searchParams.append('oid', plugin.settings.oid)
    plugin.settings.signaling = signalingURL.toString()
  }
}