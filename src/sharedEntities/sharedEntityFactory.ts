import PeerdraftPlugin from "src/peerdraftPlugin";
import { SharedEntity } from "./sharedEntity";
import { SharedDocument } from "./sharedDocument";
import { SharedFolder } from "./sharedFolder";

export const fromShareURL = async (url: string, plugin: PeerdraftPlugin): Promise<SharedEntity | void> => {
  const splittedUrl = url.split('/')
  if (splittedUrl?.contains('cm')) {
    return SharedDocument.fromShareURL(url, plugin)
  }
  if (splittedUrl?.contains('team')) {
    return SharedFolder.fromShareURL(url, plugin)
  }
}