import { App, ItemView, WorkspaceLeaf } from "obsidian";
import ShareView from './shareView.svelte';
import type PeerdraftPlugin from "src/peerdraftPlugin";

export const PEERDRAFT_SHARE_VIEW_TYPE = "peerdraft-share-view";

export class PeerdraftShareView extends ItemView {

  component: ShareView;
  plugin: PeerdraftPlugin

  constructor(leaf: WorkspaceLeaf, plugin: PeerdraftPlugin) {
    super(leaf);
    this.plugin = plugin
  }

  getViewType() {
    return PEERDRAFT_SHARE_VIEW_TYPE;
  }

  getDisplayText() {
    return "Your Peerdraft Shares";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    this.component = new ShareView({
      target: this.contentEl,
      props: {
        plugin: this.plugin
      }
    })
  }

  async onClose() {
  }
}

export const activateView = async (app: App) => {
  const { workspace } = app;

  let leaf: WorkspaceLeaf | null = null;
  const leaves = workspace.getLeavesOfType(PEERDRAFT_SHARE_VIEW_TYPE);

  if (leaves.length > 0) {
    leaf = leaves[0];
  } else {
    leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: PEERDRAFT_SHARE_VIEW_TYPE, active: true });
    }
  }
  if (leaf) {
    workspace.revealLeaf(leaf);
  }
}