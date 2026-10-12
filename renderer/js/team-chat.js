const chatMessages = document.getElementById("chatMessages");
const chatStatus = document.getElementById("chatStatus");
const chatError = document.getElementById("chatError");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const emptyState = document.getElementById("emptyState");
let newestMessageId = 0;
let hasLoadedHistory = false;
let polling = false;

function messageTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function appendMessage(message) {
  if (!Number.isInteger(message.id) || message.id <= newestMessageId) return;
  emptyState.hidden = true;
  const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  const item = document.createElement("article");
  item.className = `message${window.currentChatUserId === message.sender_id ? " own" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("strong");
  sender.textContent = message.sender_name || "Workspace member";
  const time = document.createElement("time");
  time.dateTime = message.created_at || "";
  time.textContent = messageTime(message.created_at);
  meta.append(sender, time);

  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = message.body || "";
  item.append(meta, body);
  chatMessages.append(item);
  newestMessageId = message.id;
  if (!hasLoadedHistory || nearBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function loadMessages(initial = false) {
  if (polling) return;
  polling = true;
  try {
    const cursor = initial ? "" : `?after_id=${newestMessageId}`;
    const result = await fetchJSON(`/api/team-chat/messages${cursor}`);
    if (result.error) {
      if (result.error === "Authentication required.") window.top.location.replace("/login");
      throw new Error(result.error);
    }
    if (initial) {
      window.currentChatUserId = result.current_user_id;
      for (const message of result.messages || []) appendMessage(message);
      hasLoadedHistory = true;
      chatStatus.textContent = "Messages are shared with all workspace members.";
    } else {
      for (const message of result.messages || []) appendMessage(message);
    }
    chatError.textContent = "";
  } catch (error) {
    chatError.textContent = error.message || "Could not load the conversation.";
    chatStatus.textContent = "Team Chat is temporarily unavailable.";
  } finally {
    polling = false;
  }
}

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if (!body || sendButton.disabled) return;
  sendButton.disabled = true;
  chatError.textContent = "";
  try {
    const result = await fetchJSON("/api/team-chat/messages", {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (result.error) throw new Error(result.error);
    appendMessage(result);
    messageInput.value = "";
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

loadMessages(true);
window.setInterval(() => loadMessages(false), 4000);
