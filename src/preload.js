const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  quit: () => ipcRenderer.invoke("quit-app"),
  openSettings: () => ipcRenderer.invoke("open-settings"),
  getCurrentPet: () => ipcRenderer.invoke("get-current-pet"),
  getPetProject: () => ipcRenderer.invoke("get-pet-project"),
  getApiSettings: (modelProvider) =>
    ipcRenderer.invoke("get-api-settings", { modelProvider }),
  generatePet: (payload) => ipcRenderer.invoke("generate-pet", payload),
  generatePetAnimations: (candidateId) =>
    ipcRenderer.invoke("generate-pet-animations", { candidateId }),
  resumePetAnimationJobs: () => ipcRenderer.invoke("resume-pet-animation-jobs"),
  retryFailedPetAnimationAction: (candidateId) =>
    ipcRenderer.invoke("retry-failed-pet-animation-action", { candidateId }),
  cancelPendingPetAnimations: () => ipcRenderer.invoke("cancel-pending-pet-animations"),
  moveWindow: (delta) => ipcRenderer.invoke("move-window", delta),
  showContextMenu: () => ipcRenderer.invoke("show-context-menu"),
  regenerateSingleAnimation: (payload) =>
    ipcRenderer.invoke("regenerate-single-animation", payload),
  generateMoreAnimations: (payload) =>
    ipcRenderer.invoke("generate-more-animations", payload),
  deleteAnimation: (payload) => ipcRenderer.invoke("delete-animation", payload),
  rekeyAnimation: (payload) => ipcRenderer.invoke("rekey-animation", payload),
  onPetUpdated: (callback) => {
    ipcRenderer.on("pet-updated", (_event, imageUrl) => callback(imageUrl));
  },
  onPetGenerationProgress: (callback) => {
    ipcRenderer.on("pet-generation-progress", (_event, stage) => callback(stage));
  },
  onPetAnimationProgress: (callback) => {
    ipcRenderer.on("pet-animation-progress", (_event, batch) => callback(batch));
  }
});
