import { requestUrl } from "obsidian"
import PeerdraftPlugin from "./peerdraftPlugin"
import { showNotice } from "./ui"

export const requestLoginCode = async (plugin: PeerdraftPlugin, email: string) => {

  const url = new URL("/group/login/send-mail-with-code", plugin.settings.basePath).toString()

  const data = await requestUrl({
    url,
    method: 'POST',
    contentType: "application/json",
    body: JSON.stringify({
      email
    })
  }).json

  if (!data || !data.ok) {
    return
  }
  return true

}


export const requestWebToken = async (plugin: PeerdraftPlugin, email: string, token: string, longLived: boolean) => {

  const url = new URL("/group/login/verify-code", plugin.settings.basePath).toString()

  const data = await requestUrl({
    url,
    method: 'POST',
    contentType: "application/json",
    body: JSON.stringify({
      email, token, longLived
    })
  }).json

  if (!data || !data.jwt) {
    return
  }
  return data.jwt
}

export const saveJWT = (oid: string, jwt: string) => {
  localStorage.setItem(oid + "-peerdraft-jwt", jwt)
}

export const getJWT = (oid: string) => {
  const jwt = localStorage.getItem(oid + "-peerdraft-jwt")
  if (!jwt) return null
  
  // Check if JWT is valid by trying to parse and check expiration
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    
    const payload = JSON.parse(atob(parts[1]))
    if (!payload.exp) return jwt // No expiration set, assume valid
    
    // Check if JWT is expired (exp is in seconds since epoch)
    if (payload.exp * 1000 < Date.now()) {
      // JWT is expired, remove it
      localStorage.removeItem(oid + "-peerdraft-jwt")
      return null
    }
    
    return jwt
  } catch (e) {
    // Invalid JWT format, remove it
    localStorage.removeItem(oid + "-peerdraft-jwt")
    return null
  }
}

export const clearJWT = (oid: string) => {
  localStorage.removeItem(oid + "-peerdraft-jwt")
}

export const logout = (plugin: PeerdraftPlugin) => {

  return new Promise<void>((resolve) => {
    const server = plugin.serverSync
    if (server.authenticated) {
      const handler = () => {
        clearJWT(plugin.settings.oid)
        server.jwt = undefined
        server.off('connection-close', handler)
        showNotice("Logged out of Peerdraft")
        server.connect()
        resolve()
      }
      server.on('connection-close', handler)
      server.disconnect()
    }
  })
}