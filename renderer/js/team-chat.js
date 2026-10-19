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
const threadList = document.getElementById("threadList");
const copyViber = document.getElementById("copyViber");
const viberStatus = document.getElementById("viberStatus");
let newestMessageId = 0;
let hasLoadedHistory = false;
let polling = false;
let selectedImage = null;
let selectedImageUrl = null;
let isAdmin = false;
let activeThreadId = null;
const teamMode = new URLSearchParams(window.location.search).get("channel") === "team";
const messageApi = teamMode ? "/api/team/messages" : "/api/support/messages";
const imageApi = teamMode ? "/api/team/messages" : "/api/support/messages";
if (teamMode) {
  document.title = "Team Chat | Beabots";
  document.querySelector(".eyebrow").textContent = "Team collaboration";
  document.querySelector("h1").textContent = "Team Chat";
  document.querySelector(".chat-heading p").textContent = "Share updates and coordinate with everyone on your team. All team members can see this conversation.";
  document.querySelector(".viber-contact").hidden = true;
  threadList.hidden = true;
  document.querySelector(".chat-panel").setAttribute("aria-label", "Team chat messages");
  document.getElementById("emptyState").textContent = "No team messages yet. Start the conversation.";
  messageInput.placeholder = "Write to your team…";
}

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
  sender.textContent = message.sender_name || "Support team";
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
    imageLink.href = `${imageApi}/${message.id}/image`;
    imageLink.target = "_blank";
    imageLink.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.className = "message-image";
    image.src = imageLink.href;
    image.alt = `Image shared by ${message.sender_name || "a support user"}`;
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

function clearConversation() {
  newestMessageId = 0;
  hasLoadedHistory = false;
  chatMessages.querySelectorAll(".message").forEach((node) => node.remove());
  emptyState.hidden = false;
  chatMessages.scrollTop = 0;
}

function showThreads(threads) {
  threadList.replaceChildren();
  threadList.classList.add("visible");
  for (const thread of threads) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-button${thread.user_id === activeThreadId ? " active" : ""}`;
    const name = document.createElement("strong");
    name.textContent = thread.user_name;
    const snippet = document.createElement("span");
    snippet.textContent = thread.last_message || "Image attachment";
    button.append(name, snippet);
    button.addEventListener("click", () => selectThread(thread.user_id, thread.user_name));
    threadList.append(button);
  }
}

async function refreshThreads() {
  const result = await fetchJSON("/api/support/threads");
  if (result.error) throw new Error(result.error);
  const threads = result.threads || [];
  showThreads(threads);
  if (activeThreadId && !threads.some((thread) => thread.user_id === activeThreadId)) {
    activeThreadId = null;
    clearConversation();
    chatStatus.textContent = "Select a support conversation.";
  }
  if (!activeThreadId && threads.length) await selectThread(threads[0].user_id, threads[0].user_name);
}

async function selectThread(userId, name) {
  if (activeThreadId !== userId) {
    activeThreadId = userId;
    clearConversation();
    chatStatus.textContent = `Conversation with ${name}`;
    showThreads((await fetchJSON("/api/support/threads")).threads || []);
    await loadMessages(true);
  }
}

async function loadMessages(initial = false) {
  if (polling || (!teamMode && isAdmin && !activeThreadId)) return;
  polling = true;
  try {
    const params = new URLSearchParams();
    if (!teamMode && isAdmin) params.set("user_id", activeThreadId);
    if (!initial) params.set("after_id", String(newestMessageId));
    const result = await fetchJSON(`${messageApi}?${params}`);
    if (result.error) {
      if (result.error === "Authentication required.") window.top.location.replace("/login");
      throw new Error(result.error);
    }
    for (const message of result.messages || []) appendMessage(message, result.current_user_id);
    if (initial) {
      hasLoadedHistory = true;
      if (teamMode) chatStatus.textContent = "Shared conversation with your team.";
      else if (!isAdmin) chatStatus.textContent = "Private conversation with the admin team.";
    }
    chatError.textContent = "";
  } catch (error) {
    chatError.textContent = error.message || "Could not load the support conversation.";
    chatStatus.textContent = teamMode ? "Team chat is temporarily unavailable." : "Support is temporarily unavailable.";
  } finally {
    polling = false;
  }
}

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
copyViber.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("+639556845324");
    viberStatus.textContent = "Copied. Paste the number into Viber.";
  } catch {
    viberStatus.textContent = "Search Viber for +63 955 684 5324.";
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if ((!body && !selectedImage) || sendButton.disabled || (!teamMode && isAdmin && !activeThreadId)) return;
  sendButton.disabled = true;
  chatError.textContent = "";
  try {
    const formData = new FormData();
    formData.set("body", body);
    if (!teamMode && isAdmin) formData.set("user_id", activeThreadId);
    if (selectedImage) formData.set("image", selectedImage);
    const response = await fetch(messageApi, { method: "POST", body: formData });
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    appendMessage(result, result.sender_id);
    messageInput.value = "";
    clearSelectedImage();
    chatMessages.scrollTop = chatMessages.scrollHeight;
    messageInput.focus();
    if (!teamMode && isAdmin) await refreshThreads();
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
    isAdmin = !teamMode && Boolean(auth.user?.is_admin);
    if (isAdmin) {
      chatStatus.textContent = "Loading support inbox…";
      await refreshThreads();
      if (!activeThreadId) chatStatus.textContent = "No support conversations yet.";
    } else {
      await loadMessages(true);
    }
  } catch (error) {
    chatError.textContent = error.message || "Could not load support.";
    chatStatus.textContent = teamMode ? "Team chat is temporarily unavailable." : "Support is temporarily unavailable.";
  }
}

initializeChat();
window.setInterval(() => {
  if (!teamMode && isAdmin) refreshThreads().catch(() => {});
  loadMessages(false);
}, 4000);
