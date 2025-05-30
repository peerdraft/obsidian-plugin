import { App, Modal, Plugin, Setting } from "obsidian";
import { SharedDocument } from "src/sharedEntities/sharedDocument";
import { SharedFolder } from "src/sharedEntities/sharedFolder";
import { showNotice } from "src/ui";

class SharedFolderOptionsModal extends Modal {

  folder: SharedFolder

  constructor(app: App, folder: SharedFolder) {
    super(app)
    this.folder = folder
  }

  async onOpen() {
    new Setting(this.contentEl).setName(this.folder.getOriginalFolderName()).setHeading()

    // Folder Name
    const nameSetting = new Setting(this.contentEl)
    let tempName = this.folder.getOriginalFolderName()
    nameSetting.setName("Peerdraft folder name")
    nameSetting.addText(text => {
      text.setValue(tempName)
      text.onChange(value => {
        tempName = value
      })
    })

    nameSetting.addButton(button => {
      button.setButtonText("Update")
      button.onClick(() => {
        if (tempName !== this.folder.getOriginalFolderName()) {
          this.folder.setOriginalFolderName(tempName)
          this.close()
          openFolderOptions(this.app, this.folder)
        }
      })
    })

    // Add peerdraft property

    const prop = new Setting(this.contentEl)
    prop.setName("Auto add property with Peerdraft URL")
    prop.setDesc("Leave empty if no property should be added")
    let tempProp = this.folder.getAutoFillProperty()

    prop.addText(text => {
      text.setValue(tempProp)
      text.onChange(value => {
        tempProp = value
      })
    })

    prop.addButton(button => {
      button.setButtonText("Update & Apply")
      button.onClick(async () => {
        const oldProperty = this.folder.getAutoFillProperty()
        if (tempProp !== oldProperty) {
          this.folder.setAutoFillProperty(tempProp)
        }
        const notice = showNotice("Updating URLs...")
        await this.folder.updatePropertiesOfAllDocuments(oldProperty)
        notice.hide()
        this.close()
        openFolderOptions(this.app, this.folder)
      })
    })

    const link = new Setting(this.contentEl)
    link.setName("Peerdraft URL")
    link.addButton(btn => {
      btn.setButtonText("Copy Peerdraft URL to clipboard")
      btn.onClick(()=> {
        navigator.clipboard.writeText(this.folder.getShareURL())
        showNotice("Link copied to clipboard.")
      })
    })

    // File Extensions
    const extensions = new Setting(this.contentEl)
    extensions.setName("File Extensions")
    extensions.setDesc("Comma-separated list of file extensions to sync (without leading .)")
    
    const extensionsValue = Array.from(this.folder.fileExtensions).join(', ')
    let currentExtensions = extensionsValue
    let inputEl: HTMLInputElement | null = null
    let errorEl: HTMLElement | null = null
    let updateButton: HTMLButtonElement | null = null
    let isValid = true
    
    // Function to validate extensions
    const validateExtensions = (value: string): { valid: boolean; message?: string } => {
      if (!value.trim()) {
        return { valid: false, message: "Please enter at least one file extension" }
      }
      
      const extensions = value
        .split(',')
        .map(ext => ext.trim())
        .filter(ext => ext.length > 0)
      
      if (extensions.length === 0) {
        return { valid: false, message: "Please enter at least one file extension" }
      }
      
      // Check for invalid characters in extensions
      const invalidChars = /[^a-zA-Z0-9]/
      const invalidExts = extensions.filter(ext => invalidChars.test(ext))
      
      if (invalidExts.length > 0) {
        return { 
          valid: false, 
          message: `Invalid characters in extensions: ${invalidExts.join(', ')}` 
        }
      }
      
      return { valid: true }
    }
    
    // Function to update input styling based on validation
    const updateInputValidation = (value: string) => {
      if (!inputEl) {
        console.error('Input element not found');
        return;
      }
      
      const { valid, message } = validateExtensions(value);
      isValid = valid;
      
      console.log('Input validation - valid:', valid, 'value:', value);
      
      // Update input styling
      if (!valid) {
        // Invalid state
        inputEl.style.borderColor = 'var(--text-error)';
        inputEl.style.backgroundColor = 'rgba(224, 49, 49, 0.05)';
        
        // Add shake animation
        inputEl.animate([
          { transform: 'translateX(0)' },
          { transform: 'translateX(-3px)' },
          { transform: 'translateX(3px)' },
          { transform: 'translateX(0)' }
        ], {
          duration: 300,
          iterations: 1
        });
      } else {
        // Valid state
        inputEl.style.borderColor = 'var(--background-modifier-border)';
        inputEl.style.backgroundColor = 'var(--background-primary)';
      }
      
      // Update or create error message
      if (!valid && message) {
        if (!errorEl) {
          errorEl = extensions.descEl.createEl('div');
          errorEl.style.cssText = `
            color: var(--text-error);
            font-size: 0.85em;
            margin: 6px 0 0 2px;
            line-height: 1.4;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 4px;
          `;
          
          // Add warning icon
          const icon = document.createElement('span');
          icon.textContent = '⚠️';
          icon.style.fontSize = '0.9em';
          errorEl.appendChild(icon);
          
          // Add message text
          const messageEl = document.createElement('span');
          messageEl.textContent = message;
          errorEl.appendChild(messageEl);
        } else {
          // Update existing message
          const messageEl = errorEl.querySelector('span:last-child');
          if (messageEl) {
            messageEl.textContent = message;
          }
        }
      } else if (errorEl) {
        errorEl.remove();
        errorEl = null;
      }
      
      // Update button state
      if (updateButton) {
        updateButton.disabled = !valid;
        updateButton.style.opacity = valid ? '1' : '0.7';
        updateButton.style.cursor = valid ? 'pointer' : 'not-allowed';
      }
    };
    
    // Create input field
    extensions.addText(text => {
      inputEl = text.inputEl;
      text.setValue(extensionsValue);
      
      // Set base styles
      Object.assign(text.inputEl.style, {
        width: '100%',
        marginBottom: '4px',
        padding: '6px 8px',
        borderRadius: '4px',
        border: '2px solid var(--background-modifier-border)',
        backgroundColor: 'var(--background-primary)',
        transition: 'all 0.2s ease-in-out',
        boxSizing: 'border-box'
      });
      
      // Focus styles
      text.inputEl.addEventListener('focus', () => {
        text.inputEl.style.borderColor = 'var(--interactive-accent)';
        text.inputEl.style.boxShadow = '0 0 0 2px var(--background-modifier-border-hover)';
        text.inputEl.style.outline = 'none';
      });
      
      text.inputEl.addEventListener('blur', () => {
        text.inputEl.style.boxShadow = '';
        if (isValid) {
          text.inputEl.style.borderColor = 'var(--background-modifier-border)';
        }
      });
      
      // Use the input event for immediate feedback
      text.inputEl.addEventListener('input', (e) => {
        const value = (e.target as HTMLInputElement).value;
        currentExtensions = value;
        updateInputValidation(value);
      });
      
      // Initial validation
      updateInputValidation(extensionsValue);
    });

    // Add update button
    extensions.addButton(button => {
      updateButton = button.buttonEl
      button.setButtonText("Update Extensions")
      button.setDisabled(!isValid)
      
      button.onClick(async () => {
        if (!isValid || !inputEl) return;
        
        // Get new extensions
        const newExtensions = new Set(
          currentExtensions
            .split(',')
            .map(ext => ext.trim())
            .filter(ext => ext)
        );
        
        // Get current files in the folder
        const files = this.app.vault.getFiles()
          .filter(file => file.path.startsWith(this.folder.root.path));
        
        // Find files that will be included/excluded
        const currentExts = this.folder.fileExtensions;
        const addedFiles: string[] = [];
        const removedFiles: string[] = [];
        
        files.forEach(file => {
          const ext = file.extension.toLowerCase();
          const currentlyIncluded = currentExts.has(ext);
          const willBeIncluded = newExtensions.has(ext);
          
          if (!currentlyIncluded && willBeIncluded) {
            addedFiles.push(file.path);
          } else if (currentlyIncluded && !willBeIncluded) {
            removedFiles.push(file.path);
          }
        });
        
        // Show confirmation dialog if there are changes
        if (addedFiles.length > 0 || removedFiles.length > 0) {
          const modal = new Modal(this.app);
          modal.titleEl.setText('Confirm File Sharing Changes');
          
          const content = modal.contentEl.createEl('div');
          content.createEl('p', {
            text: 'The following changes will be made to shared files:'
          });
          
          if (addedFiles.length > 0) {
            const addedSection = content.createEl('div');
            addedSection.createEl('h4', {
              text: `Files that will be SHARED (${addedFiles.length}):`
            });
            const addedList = addedSection.createEl('ul');
            addedFiles.slice(0, 10).forEach(file => {
              addedList.createEl('li', { text: file });
            });
            if (addedFiles.length > 10) {
              addedSection.createEl('p', {
                text: `...and ${addedFiles.length - 10} more files`
              });
            }
          }
          
          if (removedFiles.length > 0) {
            const removedSection = content.createEl('div');
            removedSection.createEl('h4', {
              text: `Files that will be UNSHARED (${removedFiles.length}):`
            });
            const removedList = removedSection.createEl('ul');
            removedFiles.slice(0, 10).forEach(file => {
              removedList.createEl('li', { text: file });
            });
            if (removedFiles.length > 10) {
              removedSection.createEl('p', {
                text: `...and ${removedFiles.length - 10} more files`
              });
            }
          }
          
          const buttonContainer = content.createEl('div', {
            cls: 'pd-button-container'
          });
          
          buttonContainer.createEl('button', {
            text: 'Cancel',
            cls: 'mod-warning'
          }).addEventListener('click', () => {
            modal.close();
          });
          
          const confirmBtn = buttonContainer.createEl('button', {
            text: 'Confirm Changes',
            cls: 'mod-cta'
          });
          
          confirmBtn.addEventListener('click', async () => {
            modal.close();
            
            // Update the extensions
            const oldExtensions = this.folder.fileExtensions;
            this.folder.setFileExtensions(Array.from(newExtensions));
            
            // Get all files in the folder
            const files = this.app.vault.getFiles()
              .filter(file => file.path.startsWith(this.folder.root.path));
            
            // Process files that need to be added/removed
            for (const file of files) {
              const ext = file.extension.toLowerCase();
              const wasIncluded = oldExtensions.has(ext);
              const isNowIncluded = newExtensions.has(ext);
              
              if (isNowIncluded && !wasIncluded) {
                // Add document to shared folder
                const doc = await SharedDocument.fromTFile(file, { permanent: true }, this.folder.plugin);
                if (doc) {
                  this.folder.addDocument(doc);
                }
              } else if (!isNowIncluded && wasIncluded) {
                // Remove document from shared folder
                const doc = SharedDocument.findByPath(file.path);
                if (doc) {
                  this.folder.removeDocument(doc);
                  doc.unshare();
                }
              }
            }
            
            showNotice("File extensions and sharing settings updated successfully");
          });
          
          modal.open();
        } else {
          // No changes to file sharing, just update extensions
          this.folder.setFileExtensions(Array.from(newExtensions));
          showNotice("File extensions updated");
        }
      });
    })


  }
}

export const openFolderOptions = (app: App, folder: SharedFolder) => {
  new SharedFolderOptionsModal(app, folder).open()
}