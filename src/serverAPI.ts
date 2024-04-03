import { requestUrl } from "obsidian"
import { showNotice } from "./ui"

export class ServerAPI {


  constructor(
    private opts: {
      oid: string,
      permanentSessionUrl: string
    }
  ){}

  async createPermanentSession () {
    const data = await requestUrl({
      url: this.opts.permanentSessionUrl,
      method: 'POST',
      contentType: "application/json",
      body: JSON.stringify({
        oid: this.opts.oid
      })
    }).json
  
    if (!data || !data.id) {
      showNotice("Error creating shared file")
      return 
    }
    return data as {id: string}
  }

}
