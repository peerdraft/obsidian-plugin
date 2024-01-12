import { Plugin } from "obsidian";
import { getSettings } from "./settings";
import { session } from '@electron/remote';

export const setCookie = async (plugin: Plugin) => {
  const settings = await getSettings(plugin)
  await session.defaultSession.cookies.set({ url: "https://www.peerdraft.app", "name": "oid", "value": settings.oid, "domain": "www.peerdraft.app", "path": "/", "secure": true, "httpOnly": true, "sameSite": "no_restriction" })
}