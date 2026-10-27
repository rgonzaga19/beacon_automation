const chatMessages = document.getElementById("chatMessages");
const chatStatus = document.getElementById("chatStatus");
const chatError = document.getElementById("chatError");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const emptyState = document.getElementById("emptyState");
const imageInput = document.getElementById("imageInput");
const attachButton = document.getElementById("attachButton");
const attachmentPreview = document.getElementById("attachmentPreview");
const attachmentThumbnail = document.getElementById("attachmentThumbnail");
const attachmentName = document.getElementById("attachmentName");
const removeAttachment = document.getElementById("removeAttachment");
const messageApi = "/api/team/messages";
let newestMessageId = 0;
let hasLoadedHistory = false;
let polling = false;
let selectedImage = null;
let selectedImageUrl = null;

function messageTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function appendMessage(message, currentUserId) {
  if (!Number.isInteger(message.id) || message.id <= newestMessageId) return;
  emptyState.hidden = true;
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  const item = document.createElement("article");
  item.className = `message${currentUserId === message.sender_id ? " own" : ""}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("strong");
  sender.textContent = message.sender_name || "Team member";
  const time = document.createElement("time");
  time.dateTime = message.created_at || "";
  time.textContent = messageTime(message.created_at);
  meta.append(sender, time);
  item.append(meta);
  if (message.body) {
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.body;
    item.append(body);
  }
  if (message.has_image) {
    const imageLink = document.createElement("a");
    imageLink.className = "message-image-link";
    imageLink.href = `${messageApi}/${message.id}/image`;
    imageLink.target = "_blank";
    imageLink.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.className = "message-image";
    image.src = imageLink.href;
    image.alt = `Image shared by ${message.sender_name || "a team member"}`;
    image.loading = "lazy";
    image.decoding = "async";
    imageLink.append(image);
    item.append(imageLink);
  }
  chatMessages.append(item);
  newestMessageId = message.id;
  if (!hasLoadedHistory || nearBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearSelectedImage() {
  if (selectedImageUrl) URL.revokeObjectURL(selectedImageUrl);
  selectedImage = null;
  selectedImageUrl = null;
  imageInput.value = "";
  attachmentThumbnail.removeAttribute("src");
  attachmentName.textContent = "";
  attachmentPreview.hidden = true;
}

async function loadMessages(initial = false) {
  if (polling) return;
  polling = true;
  try {
    const params = new URLSearchParams();
    if (!initial) params.set("after_id", String(newestMessageId));
    const result = await fetchJSON(`${messageApi}?${params}`);
    if (result.error) {
      if (result.error === "Authentication required.") window.top.location.replace("/login");
      throw new Error(result.error);
    }
    for (const message of result.messages || []) appendMessage(message, result.current_user_id);
    markChatReadIfVisible();
    if (initial) {
      hasLoadedHistory = true;
      chatStatus.textContent = "Shared conversation with your team.";
    }
    chatError.textContent = "";
  } catch (error) {
    chatError.textContent = error.message || "Could not load team chat.";
    chatStatus.textContent = "Team chat is temporarily unavailable.";
  } finally {
    polling = false;
  }
}

function markChatReadIfVisible() {
  const frame = window.frameElement;
  if (window.parent === window || !frame?.classList.contains("active") || document.visibilityState !== "visible") return;
  window.parent.postMessage({ type: "chat-read", channel: "team", messageId: newestMessageId }, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data?.type === "chat-active") markChatReadIfVisible();
});
document.addEventListener("visibilitychange", markChatReadIfVisible);

attachButton.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => {
  const image = imageInput.files?.[0];
  if (!image) return;
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.type)) {
    chatError.textContent = "Choose a PNG, JPEG, GIF, or WebP image.";
    clearSelectedImage();
    return;
  }
  if (image.size > 5 * 1024 * 1024) {
    chatError.textContent = "Images must be 5 MB or smaller.";
    clearSelectedImage();
    return;
  }
  if (selectedImageUrl) URL.revokeObjectURL(selectedImageUrl);
  selectedImage = image;
  selectedImageUrl = URL.createObjectURL(image);
  attachmentThumbnail.src = selectedImageUrl;
  attachmentName.textContent = image.name;
  attachmentPreview.hidden = false;
  chatError.textContent = "";
});
removeAttachment.addEventListener("click", clearSelectedImage);

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if ((!body && !selectedImage) || sendButton.disabled) return;
  sendButton.disabled = true;
  chatError.textContent = "";
  try {
    const formData = new FormData();
    formData.set("body", body);
    if (selectedImage) formData.set("image", selectedImage);
    const response = await fetch(messageApi, { method: "POST", body: formData });
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    appendMessage(result, result.sender_id);
    messageInput.value = "";
    clearSelectedImage();
    chatMessages.scrollTop = chatMessages.scrollHeight;
    messageInput.focus();
  } catch (error) {
    chatError.textContent = error.message || "Could not send your message.";
  } finally {
    sendButton.disabled = false;
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

async function initializeChat() {
  try {
    const auth = await fetchJSON("/api/auth/me");
    if (!auth.authenticated) {
      window.top.location.replace("/login");
      return;
    }
    await loadMessages(true);
  } catch (error) {
    chatError.textContent = error.message || "Could not load team chat.";
    chatStatus.textContent = "Team chat is temporarily unavailable.";
  }
}

initializeChat();
window.setInterval(() => loadMessages(false), 4000);
