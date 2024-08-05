import { requestUrl } from "obsidian"
import { showNotice } from "./ui"

export class ServerAPI {


  constructor(
    private opts: {
      oid: string,
      permanentSessionUrl: string
    }
  ){}

  async isSessionPermanent (id: string) {
    const data = await requestUrl({
      url: this.opts.permanentSessionUrl + "/" + id,
      method: 'GET',
      contentType: "application/json",
    }).json
  
    if (!data) {
      showNotice("Error creating shared file")
      return 
    }
    return !!data.permanent
  }
}
