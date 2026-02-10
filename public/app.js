// =========================================================================
// OpenClaw Webchat – Client
// =========================================================================

(() => {
  "use strict";

  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  const loginScreen = document.getElementById("login-screen");
  const chatScreen = document.getElementById("chat-screen");
  const loginForm = document.getElementById("login-form");
  const passwordInput = document.getElementById("password-input");
  const loginError = document.getElementById("login-error");

  const messagesEl = document.getElementById("messages");
  const messageInput = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const fileInput = document.getElementById("file-input");
  const attachmentPreview = document.getElementById("attachment-preview");

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let conversationHistory = []; // array of OpenResponses input items
  let displayHistory = [];     // lightweight log for localStorage (no base64)
  let pendingAttachments = []; // { type, data }  ready-to-send items
  let isStreaming = false;

  const STORAGE_KEY = "roboto_chat_history";

  // Allowed MIME types (matching OpenClaw limits)
  const IMAGE_MIMES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const FILE_MIMES = new Set([
    "text/plain",
    "text/markdown",
    "text/html",
    "text/csv",
    "application/json",
    "application/pdf",
  ]);

  // Configure marked
  if (typeof marked !== "undefined") {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

  // -----------------------------------------------------------------------
  // Persistence helpers (localStorage)
  // -----------------------------------------------------------------------
  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(displayHistory));
    } catch {
      // Storage full or unavailable -- silently ignore
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        displayHistory = JSON.parse(raw);
        return true;
      }
    } catch {
      // Corrupted -- ignore
    }
    return false;
  }

  function clearHistory() {
    displayHistory = [];
    localStorage.removeItem(STORAGE_KEY);
  }

  function restoreMessages() {
    messagesEl.innerHTML = "";
    conversationHistory = [];

    for (const entry of displayHistory) {
      if (entry.role === "user") {
        // Re-render user bubble
        addUserMessage(entry.text, entry.attachments || []);
        // Rebuild conversationHistory for API context
        const contentItems = [];
        if (entry.attachments) {
          for (const att of entry.attachments) {
            // We don't have the base64 data anymore, just metadata
            // OpenClaw session handles history via the `user` field
          }
        }
        if (entry.text) {
          contentItems.push({ type: "input_text", text: entry.text });
        }
        conversationHistory.push({
          type: "message",
          role: "user",
          content: contentItems,
        });
      } else if (entry.role === "assistant") {
        // Re-render assistant bubble with avatar
        addAssistantMessage(entry.text);
        conversationHistory.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: entry.text }],
        });
      }
    }

    scrollToBottom();
  }

  // -----------------------------------------------------------------------
  // Session check on load
  // -----------------------------------------------------------------------
  async function checkSession() {
    try {
      const res = await fetch("/api/session");
      const data = await res.json();
      if (data.authenticated) {
        showChat();
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.hidden = false;
    chatScreen.hidden = true;
    passwordInput.focus();
  }

  function showChat() {
    loginScreen.hidden = true;
    chatScreen.hidden = false;
    if (loadHistory()) {
      restoreMessages();
    }
    messageInput.focus();
  }

  // -----------------------------------------------------------------------
  // Login
  // -----------------------------------------------------------------------
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const password = passwordInput.value;

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        passwordInput.value = "";
        showChat();
      } else {
        loginError.hidden = false;
      }
    } catch {
      loginError.textContent = "Network error";
      loginError.hidden = false;
    }
  });

  // -----------------------------------------------------------------------
  // Logout
  // -----------------------------------------------------------------------
  logoutBtn.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    conversationHistory = [];
    messagesEl.innerHTML = "";
    pendingAttachments = [];
    clearHistory();
    renderAttachmentPreview();
    showLogin();
  });

  // -----------------------------------------------------------------------
  // Auto-resize textarea
  // -----------------------------------------------------------------------
  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + "px";
  });

  // Send on Enter (Shift+Enter for newline)
  messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", () => sendMessage());

  // -----------------------------------------------------------------------
  // File / image attachment handling
  // -----------------------------------------------------------------------
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files);
    for (const file of files) {
      processFile(file);
    }
    fileInput.value = "";
  });

  function processFile(file) {
    const isImage = IMAGE_MIMES.has(file.type);
    const isFile = FILE_MIMES.has(file.type);

    if (!isImage && !isFile) {
      addErrorMessage(
        `Unsupported file type: ${file.type || "unknown"}. Allowed: images (jpeg, png, gif, webp) and documents (txt, md, html, csv, json, pdf).`
      );
      return;
    }

    // Check size limits
    if (isImage && file.size > 10 * 1024 * 1024) {
      addErrorMessage(`Image "${file.name}" exceeds 10 MB limit.`);
      return;
    }
    if (isFile && file.size > 5 * 1024 * 1024) {
      addErrorMessage(`File "${file.name}" exceeds 5 MB limit.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];

      if (isImage) {
        pendingAttachments.push({
          type: "input_image",
          source: {
            type: "base64",
            media_type: file.type,
            data: base64,
          },
          _preview: reader.result, // for UI preview
          _name: file.name,
        });
      } else {
        pendingAttachments.push({
          type: "input_file",
          source: {
            type: "base64",
            media_type: file.type,
            data: base64,
            filename: file.name,
          },
          _name: file.name,
        });
      }

      renderAttachmentPreview();
    };
    reader.readAsDataURL(file);
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      attachmentPreview.hidden = true;
      attachmentPreview.innerHTML = "";
      return;
    }

    attachmentPreview.hidden = false;
    attachmentPreview.innerHTML = pendingAttachments
      .map((att, i) => {
        const thumb =
          att.type === "input_image"
            ? `<img src="${att._preview}" alt="" />`
            : "";
        return `<div class="attachment-chip">
          ${thumb}
          <span>${escapeHtml(att._name)}</span>
          <button class="remove-attachment" data-idx="${i}">&times;</button>
        </div>`;
      })
      .join("");

    // Wire up remove buttons
    attachmentPreview.querySelectorAll(".remove-attachment").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        pendingAttachments.splice(idx, 1);
        renderAttachmentPreview();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Send message
  // -----------------------------------------------------------------------
  async function sendMessage() {
    if (isStreaming) return;

    const text = messageInput.value.trim();
    if (!text && pendingAttachments.length === 0) return;

    // Build the user content items for this turn
    const userContentItems = [];

    // Add attachment items (images and files go first)
    const attachmentsForDisplay = [...pendingAttachments];
    for (const att of pendingAttachments) {
      if (att.type === "input_image") {
        userContentItems.push({
          type: "input_image",
          source: { ...att.source },
        });
      } else {
        userContentItems.push({
          type: "input_file",
          source: { ...att.source },
        });
      }
    }

    // Add text
    if (text) {
      userContentItems.push({
        type: "input_text",
        text,
      });
    }

    // Build the user message item for conversation history
    const userMessage = {
      type: "message",
      role: "user",
      content: userContentItems,
    };

    // Add to conversation history
    conversationHistory.push(userMessage);

    // Save lightweight display entry (no base64 data)
    displayHistory.push({
      role: "user",
      text,
      attachments: attachmentsForDisplay.map((att) => ({
        type: att.type,
        _name: att._name,
      })),
    });
    saveHistory();

    // Render user bubble
    addUserMessage(text, attachmentsForDisplay);

    // Reset input
    messageInput.value = "";
    messageInput.style.height = "auto";
    pendingAttachments = [];
    renderAttachmentPreview();

    // Stream the response
    await streamResponse();
  }

  // -----------------------------------------------------------------------
  // Stream response from backend
  // -----------------------------------------------------------------------
  async function streamResponse() {
    isStreaming = true;
    sendBtn.disabled = true;

    // Show typing indicator with avatar
    const typingRow = document.createElement("div");
    typingRow.className = "typing-row";
    typingRow.innerHTML =
      '<img src="/avatar.png" alt="" class="assistant-avatar" />' +
      '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    messagesEl.appendChild(typingRow);
    scrollToBottom();

    let assistantText = "";
    let bubbleEl = null;
    let assistantRow = null;

    function ensureBubble() {
      if (bubbleEl) return;
      // Replace typing indicator with the real bubble
      typingRow.remove();
      assistantRow = document.createElement("div");
      assistantRow.className = "assistant-row";
      const avatarImg = document.createElement("img");
      avatarImg.src = "/avatar.png";
      avatarImg.alt = "";
      avatarImg.className = "assistant-avatar";
      bubbleEl = document.createElement("div");
      bubbleEl.className = "message assistant";
      assistantRow.appendChild(avatarImg);
      assistantRow.appendChild(bubbleEl);
      messagesEl.appendChild(assistantRow);
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: conversationHistory }),
      });

      if (!res.ok) {
        typingRow.remove();
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      // Read the SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);

              // Extract text deltas
              if (event.type === "response.output_text.delta" && event.delta) {
                ensureBubble();
                assistantText += event.delta;
                renderMarkdown(bubbleEl, assistantText);
                scrollToBottom();
              }


              // Handle completed response (non-streaming fallback)
              if (event.type === "response.completed" && event.response) {
                const output = event.response.output;
                if (output && output.length > 0) {
                  for (const item of output) {
                    if (item.type === "message" && item.content) {
                      for (const part of item.content) {
                        if (
                          part.type === "output_text" &&
                          part.text &&
                          !assistantText
                        ) {
                          ensureBubble();
                          assistantText = part.text;
                          renderMarkdown(bubbleEl, assistantText);
                          scrollToBottom();
                        }
                      }
                    }
                  }
                }
              }
            } catch {
              // Ignore JSON parse errors on partial data
            }
          }
        }
      }

      // If no text was streamed, show a fallback
      if (!assistantText) {
        ensureBubble();
        assistantText = "(No response)";
        bubbleEl.textContent = assistantText;
      }
      // Clean up typing indicator if it's still around
      typingRow.remove();

      // Add assistant message to conversation history
      conversationHistory.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      });

      // Save to display history
      displayHistory.push({ role: "assistant", text: assistantText });
      saveHistory();
    } catch (err) {
      typingRow.remove();
      addErrorMessage(err.message || "Something went wrong");

      // Remove the last user message from history since the request failed
      conversationHistory.pop();
      displayHistory.pop();
      saveHistory();
    } finally {
      isStreaming = false;
      sendBtn.disabled = false;
      messageInput.focus();
    }
  }

  // -----------------------------------------------------------------------
  // UI helpers
  // -----------------------------------------------------------------------
  function addUserMessage(text, attachments) {
    const el = document.createElement("div");
    el.className = "message user";

    let html = "";

    // Show attachment thumbnails
    if (attachments && attachments.length > 0) {
      html += '<div class="message-attachments">';
      for (const att of attachments) {
        if (att.type === "input_image") {
          html += `<img src="${att._preview}" alt="${escapeHtml(att._name)}" />`;
        } else {
          html += `<span class="file-chip">${escapeHtml(att._name)}</span>`;
        }
      }
      html += "</div>";
    }

    if (text) {
      html += `<span>${escapeHtml(text)}</span>`;
    }

    el.innerHTML = html;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addAssistantMessage(text) {
    const row = document.createElement("div");
    row.className = "assistant-row";
    const avatarImg = document.createElement("img");
    avatarImg.src = "/avatar.png";
    avatarImg.alt = "";
    avatarImg.className = "assistant-avatar";
    const bubble = document.createElement("div");
    bubble.className = "message assistant";
    renderMarkdown(bubble, text);
    row.appendChild(avatarImg);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
  }

  function addErrorMessage(text) {
    const el = document.createElement("div");
    el.className = "message error-msg";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // File extensions that get rendered as download cards
  const FILE_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|rar|csv|txt|md|json|xml|yaml|yml|html|css|js|py|rb|go|rs|java|c|cpp|h|sh)$/i;

  const FILE_ICONS = {
    pdf: "\u{1F4C4}", // page
    doc: "\u{1F4DD}", docx: "\u{1F4DD}",
    xls: "\u{1F4CA}", xlsx: "\u{1F4CA}",
    ppt: "\u{1F4CA}", pptx: "\u{1F4CA}",
    zip: "\u{1F4E6}", tar: "\u{1F4E6}", gz: "\u{1F4E6}", rar: "\u{1F4E6}",
    csv: "\u{1F4CA}",
    _default: "\u{1F4CE}", // paperclip
  };

  function getFileIcon(filename) {
    const ext = (filename.match(/\.(\w+)$/) || [])[1];
    return (ext && FILE_ICONS[ext.toLowerCase()]) || FILE_ICONS._default;
  }

  function getFileName(url) {
    try {
      const pathname = new URL(url, window.location.origin).pathname;
      return decodeURIComponent(pathname.split("/").pop()) || "file";
    } catch {
      return url.split("/").pop() || "file";
    }
  }

  function renderMarkdown(el, text) {
    if (typeof marked !== "undefined") {
      el.innerHTML = marked.parse(text);
    } else {
      el.textContent = text;
    }
    // Post-process: turn file links into download cards
    el.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      if (FILE_EXTENSIONS.test(href)) {
        const name = getFileName(href);
        const icon = getFileIcon(name);
        const card = document.createElement("a");
        card.href = href;
        card.target = "_blank";
        card.rel = "noopener";
        card.className = "file-download-card";
        card.download = name;
        card.innerHTML =
          `<span class="file-download-icon">${icon}</span>` +
          `<span class="file-download-info">` +
            `<span class="file-download-name">${escapeHtml(name)}</span>` +
            `<span class="file-download-action">Tap to download</span>` +
          `</span>`;
        a.replaceWith(card);
      }
    });
    // Also make image links open in new tab on tap
    el.querySelectorAll("img").forEach((img) => {
      if (!img.parentElement || img.parentElement.tagName !== "A") {
        const wrapper = document.createElement("a");
        wrapper.href = img.src;
        wrapper.target = "_blank";
        wrapper.rel = "noopener";
        img.parentElement.insertBefore(wrapper, img);
        wrapper.appendChild(img);
      }
    });
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Drag & drop support
  // -----------------------------------------------------------------------
  const chatScreenEl = document.getElementById("chat-screen");

  chatScreenEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  chatScreenEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      processFile(file);
    }
  });

  // -----------------------------------------------------------------------
  // iOS virtual keyboard handling
  // -----------------------------------------------------------------------
  if (window.visualViewport) {
    const onViewportResize = () => {
      // When the iOS keyboard opens, visualViewport shrinks.
      // Adjust the chat screen height to match the visible area.
      const vh = window.visualViewport.height;
      document.documentElement.style.setProperty("height", vh + "px");
      document.body.style.setProperty("height", vh + "px");
      scrollToBottom();
    };
    window.visualViewport.addEventListener("resize", onViewportResize);
    window.visualViewport.addEventListener("scroll", onViewportResize);
  }

  // Prevent iOS bounce/pull-to-refresh on the body
  document.body.addEventListener("touchmove", (e) => {
    if (e.target.closest("#messages")) return; // allow scrolling in messages
    e.preventDefault();
  }, { passive: false });

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  checkSession();
})();
