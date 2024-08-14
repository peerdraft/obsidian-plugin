import { Modal, Setting } from "obsidian";
import { requestLoginCode, requestWebToken, saveJWT } from "src/login";
import PeerdraftPlugin from "src/peerdraftPlugin";
import { saveSettings } from "src/settings";
import { showNotice } from "src/ui";

class LoginModal extends Modal {


  plugin: PeerdraftPlugin
  cb: (success: boolean) => any
  cbCalled: boolean = false;

  storeJWT = false
  code = ''
  email = ''

  constructor(plugin: PeerdraftPlugin, cb: (success: boolean) => any) {
    super(plugin.app)
    this.plugin = plugin
    this.cb = cb
    this.email = this.plugin.settings.plan.email ?? ''
  }

  async onOpen() {
    this.contentEl.empty()
    const heading = this.plugin.settings.plan.email ? "Log in to your Peerdraft account" : "Log in or register with Peerdraft"
    const headerSetting = new Setting(this.contentEl).setName(heading) //.setHeading().setDesc("")

    const headerDiv = headerSetting.descEl.createDiv()

    headerDiv.createSpan({ text: "To initiate new shared documents or folders you need to have a Peerdraft account. Collaborators can join without registration. If you need any help, " })
    headerDiv.createEl("a", {
      text: "get in touch",
      attr: {
        href: "mailto:dominik@peerdraft.app"
      }
    })
    headerDiv.createSpan({ text: '.' })

    const emailSetting = new Setting(this.contentEl)
    emailSetting.setName("Your e-mail address")
    emailSetting.descEl.innerHTML = 'By signing up or logging in, you agree to <a href="https://www.peerdraft.app/terms">the Terms of Service</a> and the <a href="https://www.peerdraft.app/privacy">Privacy Policy</a>.'
    emailSetting.addText(text => {
      text.inputEl.setAttr("type", "email")
      text.setValue(this.email)
      text.onChange(value => {
        this.email = value
      })
    })

    emailSetting.addButton(button => {
      button.setButtonText("Send Login Code")
      button.onClick(async () => {
        if (!this.email.match(/^\S+@\S+\.\S+$/)) {
          showNotice("Please enter a valid email address.")
        } else {

          const code = await requestLoginCode(this.plugin, this.email)

          if (code) {
            showNotice("Code sent to " + this.email + ".")
          } else {
            showNotice("Something went wrong. Please try again or get in touch with peerdraft support.")
          }
        }
      })
    })

    const rememberSetting = new Setting(this.contentEl)
    rememberSetting.setName("Remember me")
    rememberSetting.setDesc("If disabled, you will be asked to log in on every restart of Obsidian.")
    rememberSetting.addToggle((toggl) => {
      toggl.setValue(this.storeJWT)
      toggl.onChange(value => {
        this.storeJWT = value
        this.onOpen()
      })
    })


    const codeSetting = new Setting(this.contentEl)
    codeSetting.setName("Login Code")
    codeSetting.setDesc("Enter the code you received via email.")
    codeSetting.addText(text => {
      text.inputEl.setAttr("type", "password")
      text.setValue(this.code)
      text.onChange(value => {
        this.code = value
      })
    })

    codeSetting.addButton(button => {
      const text = this.storeJWT ? "Log in and remember me" : "Log in for this session only"
      button.setButtonText(text)
      button.onClick(async () => {
        if (!this.email.match(/^\S+@\S+\.\S+$/)) {
          showNotice("Please enter a valid email address.")
          return
        }

        if (!this.code) {
          return
        }

        const jwt = await requestWebToken(this.plugin, this.email, this.code, this.storeJWT)


        if (jwt) {
          this.plugin.settings.plan.email = this.email
          saveSettings(this.plugin.settings, this.plugin)

          if (await this.plugin.serverSync.authenticate(jwt, this.plugin.manifest.version)) {
            if (this.storeJWT) {
              saveJWT(this.plugin.settings.oid, jwt)
            }
            this.cb(true)
            this.cbCalled = true
            this.close()
          }
        } else {
          showNotice("Something went wrong. Please try again or get in touch with peerdraft support.")
        }
      })

    })

  }

  onClose = () => {
    if (!this.cbCalled) {
      this.cb(false)
      this.cbCalled = true
    }
  }
}

export const openLoginModal = (peerdraftPlugin: PeerdraftPlugin) => {

  return new Promise<boolean>((resolve) => {
    new LoginModal(peerdraftPlugin, (cb) => {
      resolve(cb)
    }).open()
  })

}