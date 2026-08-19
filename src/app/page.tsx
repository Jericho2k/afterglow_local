"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, Character, ChatInstructionPreset, Conversation, Memory, MemoryArc, Message, Persona, UsageResponse, World } from "@/lib/types";
import { compactMessagePreview, tokenizeCharacterMessage } from "@/lib/message-format";

type CharacterDraft = Omit<Character, "id" | "createdAt" | "updatedAt">;
type WorldWithCount = World & { characterCount?: number };
type AppView = "home" | "chats" | "worlds" | "profile" | "likes";

const blankCharacter: CharacterDraft = {
  name: "", profileType: "single", tagline: "", avatarUrl: "", accent: "#e879a9", backstory: "", cast: [], lorebook: "", personality: "", scenario: "",
  greeting: "", alternateGreetings: [], exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "", worldIds: [], nsfwEnabled: false,
};

function characterDraft(character?: Character | null): CharacterDraft {
  if (!character) return { ...blankCharacter, cast: [], alternateGreetings: [], worldIds: [] };
  return {
    name: character.name, profileType: character.profileType, tagline: character.tagline, avatarUrl: character.avatarUrl, accent: character.accent,
    backstory: character.backstory, cast: character.cast.map((member) => ({ ...member })), lorebook: character.lorebook, personality: character.personality,
    scenario: character.scenario, greeting: character.greeting, alternateGreetings: [...character.alternateGreetings], exampleDialogue: character.exampleDialogue,
    responseDirective: character.responseDirective, boundaries: character.boundaries, sourceMaterial: character.sourceMaterial, worldIds: [...character.worldIds], nsfwEnabled: character.nsfwEnabled,
  };
}

function fieldRows(value: string, minimum: number, maximum = 18) { return Math.min(maximum, Math.max(minimum, Math.ceil(value.length / 420))); }

const defaultSettings: AppSettings = {
  ownerName: "You", ownerProfile: "", model: "deepseek-v4-flash", roleplayPreset: "immersive", temperature: 0.95, maxTokens: 1800,
  contextMessages: 30, contextTokenBudget: 12000, consolidationInterval: 10, memoryLimit: 8, memoryTokenBudget: 6000,
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?"; }
function time(value: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function memoriesUrl(characterId: string, conversationId?: string | null) { const params = new URLSearchParams({ characterId }); if (conversationId) params.set("conversationId",conversationId); return `/api/memories?${params}`; }
async function imageFileData(file: File) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 2_400_000) throw new Error("Image files must be smaller than 2.4 MB for database storage.");
  return await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read that image")); reader.readAsDataURL(file); });
}

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [ageAccepted, setAgeAccepted] = useState<boolean | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryArcs, setMemoryArcs] = useState<MemoryArc[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [worlds, setWorlds] = useState<WorldWithCount[]>([]);
  const [composer, setComposer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("home");
  const [studioStartSection, setStudioStartSection] = useState<"identity" | "definition" | "world">("identity");
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [editing, setEditing] = useState<Character | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [recallMessage, setRecallMessage] = useState<Message | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => characters.find((item) => item.id === selectedId) ?? null, [characters, selectedId]);
  const activePersona = useMemo(() => personas.find((item) => item.id === conversation?.personaId) ?? personas.find((item) => item.isDefault) ?? null, [personas, conversation?.personaId]);

  const loadChat = useCallback(async (characterId: string, conversationId?: string) => {
    const query = new URLSearchParams({ characterId });
    if (conversationId) query.set("conversationId", conversationId);
    const data = await api<{ conversations: Conversation[]; conversation: Conversation; messages: Message[] }>(`/api/conversations?${query}`);
    setConversations(data.conversations); setConversation(data.conversation); setMessages(data.messages);
    const memoryData = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(characterId,data.conversation.id));
    setMemories(memoryData.memories); setMemoryArcs(memoryData.arcs);
    return data;
  }, []);

  const loadCharacters = useCallback(async () => {
    try {
      const data = await api<{ characters: Character[] }>("/api/characters");
      setCharacters(data.characters);
      setSelectedId((current) => current && data.characters.some((item) => item.id === current) ? current : data.characters[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load characters"); }
  }, []);
  const loadLibraries = useCallback(async () => {
    const [personaData,worldData] = await Promise.all([
      api<{ personas: Persona[] }>("/api/personas"),
      api<{ worlds: WorldWithCount[] }>("/api/worlds"),
    ]);
    setPersonas(personaData.personas); setWorlds(worldData.worlds);
  }, []);

  useEffect(() => {
    setAgeAccepted(localStorage.getItem("afterglow_age_verified") === "yes");
    api<{ authenticated: boolean }>("/api/session").then((data) => setAuthenticated(data.authenticated)).catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => { if (authenticated) { void loadCharacters(); void loadLibraries().catch(() => undefined); api<{ settings: AppSettings }>("/api/settings").then((data) => setSettings(data.settings)).catch(() => undefined); } }, [authenticated, loadCharacters, loadLibraries]);
  useEffect(() => {
    if (!selectedId || !authenticated) { setConversation(null); setConversations([]); setMessages([]); setMemories([]); setMemoryArcs([]); return; }
    setError("");
    loadChat(selectedId).catch((e) => setError(e instanceof Error ? e.message : "Could not open conversation"));
  }, [selectedId, authenticated, loadChat]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" }); }, [messages, streaming]);

  async function send(action: "send" | "regenerate" | "continue" = "send", regenerationTargetOverride?: string | null) {
    if (!conversation || streaming || (action === "send" && !composer.trim())) return;
    setError(""); setStreaming(true);
    const content = action === "send" ? composer.trim() : "";
    const inferredTarget = messages.at(-1)?.role === "assistant" ? messages.at(-1)?.id ?? null : null;
    const regenerationTargetId = action === "regenerate" ? (regenerationTargetOverride === undefined ? inferredTarget : regenerationTargetOverride) : null;
    let optimisticUserId: string | null = null;
    if (action === "send") {
      setComposer("");
      optimisticUserId = crypto.randomUUID();
      setMessages((items) => [...items, { id: optimisticUserId!, conversationId: conversation.id, role: "user", content, variants: [], selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: new Date().toISOString() }]);
    }
    const placeholderId = regenerationTargetId ?? crypto.randomUUID();
    if (regenerationTargetId) setMessages((items) => items.map((message) => message.id === regenerationTargetId ? { ...message, content: "" } : message));
    else setMessages((items) => [...items, { id: placeholderId, conversationId: conversation.id, role: "assistant", content: "", variants: [], selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: new Date().toISOString() }]);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: conversation.id, content, action, userMessageId: optimisticUserId, assistantMessageId: placeholderId }) });
      if (!response.ok || !response.body) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Chat request failed"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let completed = false;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue; const event = JSON.parse(line);
          if (event.type === "delta") setMessages((items) => items.map((m) => m.id === placeholderId ? { ...m, content: m.content + event.content } : m));
          if (event.type === "done") {
            completed = true;
            setMessages((items) => items.map((m) => m.id === placeholderId ? { ...m, id: event.id, variants: event.variants, selectedVariant: event.selectedVariant, memoryIds: event.memoriesUsed ?? [], arcIds: event.arcsUsed ?? [] } : optimisticUserId && m.id === optimisticUserId && event.userMessageId ? { ...m, id: event.userMessageId } : m));
            if (action === "send" && conversation.title.startsWith("Chat with ")) {
              const title = content.replace(/\s+/g," ").slice(0,120);
              setConversation((current) => current ? { ...current,title } : current);
              setConversations((items) => items.map((item) => item.id === conversation.id ? { ...item,title } : item));
            }
          }
          if (event.type === "error") throw new Error(event.error);
        }
      }
      if (completed) await loadChat(conversation.characterId,conversation.id);
    } catch (e) {
      if (regenerationTargetId && conversation) await loadChat(conversation.characterId,conversation.id).catch(() => undefined);
      else setMessages((items) => items.filter((m) => m.id !== placeholderId));
      setError(e instanceof Error ? e.message : "The reply was interrupted");
    } finally { setStreaming(false); }
  }

  async function newConversation(greetingIndex = 0, personaId?: string | null) {
    if (!selected || streaming) return;
    try {
      const data = await api<{ conversation: Conversation; messages: Message[] }>("/api/conversations", { method: "POST", body: JSON.stringify({ characterId: selected.id, greetingIndex, personaId: personaId ?? activePersona?.id ?? null }) });
      setConversation(data.conversation); setMessages(data.messages); setConversations((items) => [data.conversation, ...items]); setHistoryOpen(false);
      const memoryData = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(selected.id,data.conversation.id)); setMemories(memoryData.memories); setMemoryArcs(memoryData.arcs);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start a new chat"); }
  }

  async function updateConversationContext(changes: Partial<Pick<Conversation,"personaId" | "instructionPresets" | "customInstructions">>) {
    if (!conversation) return;
    try {
      const data = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      setConversation(data.conversation); setConversations((items) => items.map((item) => item.id === data.conversation.id ? data.conversation : item));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this chat"); }
  }

  function beginEdit(message: Message) {
    if (streaming) return; setEditingMessageId(message.id); setEditDraft(message.content);
  }

  async function saveMessageEdit(message: Message, messagePosition: number) {
    const content = editDraft.trim();
    if (!content) return;
    if (content === message.content) { setEditingMessageId(null); return; }
    try {
      await api<{ message: Message }>(`/api/messages/${message.id}`, { method: "PATCH", body: JSON.stringify({ content, truncateAfter: true, conversationId: message.conversationId, messagePosition }) });
      setEditingMessageId(null);
      if (message.role === "user") {
        if (conversation) await loadChat(conversation.characterId,conversation.id);
        await send("regenerate", null);
      } else if (conversation) await loadChat(conversation.characterId,conversation.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not edit message"); }
  }

  async function selectVariant(message: Message, index: number, messagePosition: number) {
    if (streaming || index === message.selectedVariant || index < 0 || index >= message.variants.length) return;
    try {
      await api<{ message: Message }>(`/api/messages/${message.id}`, { method: "PATCH", body: JSON.stringify({ variantIndex: index, conversationId: message.conversationId, messagePosition }) });
      if (conversation) await loadChat(conversation.characterId,conversation.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not select that version"); }
  }

  async function deleteFromMessage(message: Message, messagePosition: number) {
    if (!conversation || streaming || !window.confirm("Delete this message and everything after it?")) return;
    try { await api(`/api/messages/${message.id}`, { method: "DELETE", body: JSON.stringify({ conversationId: message.conversationId, messagePosition }) }); await loadChat(conversation.characterId, conversation.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete message"); }
  }

  if (ageAccepted === null || authenticated === null) return <div className="splash"><Logo /><div className="pulse" /></div>;
  if (!ageAccepted) return <AgeGate onAccept={() => { localStorage.setItem("afterglow_age_verified", "yes"); setAgeAccepted(true); }} />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand"><Logo /><button className="icon-button mobile-only" aria-label="Close menu" onClick={() => setSidebarOpen(false)}>×</button></div>
        <nav className="primary-nav">
          <button className={activeView === "home" ? "active" : ""} onClick={() => { setActiveView("home"); setSidebarOpen(false); }}><span>⌂</span><strong>Home</strong></button>
          <button className={activeView === "chats" ? "active" : ""} onClick={() => { setActiveView("chats"); setSidebarOpen(false); }}><span>◫</span><strong>Chats</strong></button>
          <button onClick={() => { setStudioStartSection("identity"); setEditing(null); setStudioOpen(true); setSidebarOpen(false); }}><span>＋</span><strong>Create</strong></button>
          <button className={activeView === "worlds" ? "active" : ""} onClick={() => { setActiveView("worlds"); setSidebarOpen(false); }}><span>▤</span><strong>World</strong></button>
          <button className={activeView === "profile" ? "active" : ""} onClick={() => { setActiveView("profile"); setSidebarOpen(false); }}><span>◉</span><strong>Profile</strong></button>
          <button className={activeView === "likes" ? "active" : ""} onClick={() => { setActiveView("likes"); setSidebarOpen(false); }}><span>♡</span><strong>Likes</strong></button>
          <button onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}><span>⚙</span><strong>Settings</strong></button>
        </nav>
        <div className="section-label"><span>Recent characters</span><span>{characters.length}</span></div>
        <div className="character-list">
          {characters.slice(0,6).map((character) => (
            <div key={character.id} className={`character-row ${selectedId === character.id ? "active" : ""}`}>
              <button className="character-select" onClick={() => { setSelectedId(character.id); setActiveView("chats"); setSidebarOpen(false); }}>
                <Avatar character={character} /><span className="character-copy"><strong>{character.name}</strong><small>{character.profileType === "ensemble" ? "Multiple characters" : "Character"}</small></span>
              </button>
              <button className="character-manage" aria-label={`View or edit ${character.name}`} title="View, edit, or delete character" onClick={() => { setStudioStartSection("identity"); setEditing(character); setStudioOpen(true); }}>•••</button>
            </div>
          ))}
        </div>
        <div className="sidebar-footer"><div className="privacy-pill"><span>◆</span><div><strong>{activePersona?.name || "Private profile"}</strong><small>{activePersona ? "Active chat persona" : "Your database, your API key"}</small></div></div><div className="sidebar-links"><button className="sidebar-lock" aria-label="Lock app" title="Lock app" onClick={async () => { await api("/api/auth", { method: "DELETE" }); setSidebarOpen(false); setAuthenticated(false); }}>◇ Lock</button></div></div>
      </aside>
      {activeView !== "chats" && <button className="global-mobile-menu" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>☰</button>}

      {activeView === "home" ? <HomeFeed characters={characters} onOpen={(character) => { setSelectedId(character.id); setActiveView("chats"); }} onCreate={() => { setEditing(null); setStudioStartSection("identity"); setStudioOpen(true); }} /> : activeView === "worlds" ? <WorldLibrary worlds={worlds} onChange={() => void loadLibraries()} /> : activeView === "profile" ? <PersonaLibrary personas={personas} onChange={() => void loadLibraries()} /> : activeView === "likes" ? <PlaceholderView icon="♡" title="Your liked characters" text="Liked public characters will collect here once discovery and publishing are enabled." /> : selected ? (
        <section className="chat-panel">
          <header className="chat-header">
            <div className="chat-identity"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button><button className="identity-profile" title="View or edit character profile" onClick={() => { setStudioStartSection("identity"); setEditing(selected); setStudioOpen(true); }}><Avatar character={selected} large /><span><span className="eyebrow conversation-preview" title={conversation?.title}>{compactMessagePreview(conversation?.title || "Private conversation")}</span><strong>{selected.name}</strong><small>{selected.profileType === "ensemble" ? "Multiple characters" : `Chatting as ${activePersona?.name || "You"}`}</small></span></button></div>
            <div className="header-actions">
              <button className="icon-button labeled" onClick={() => setHistoryOpen(true)}><span>◫</span><span>Chats</span>{conversations.length > 1 && <b>{conversations.length}</b>}</button>
              <button className="icon-button labeled" onClick={() => setMemoryOpen(true)}><span>⌁</span><span>Memories</span>{memories.length > 0 && <b>{memories.length}</b>}</button>
              <button className="icon-button labeled" title="View, edit, or delete character" onClick={() => { setStudioStartSection("identity"); setEditing(selected); setStudioOpen(true); }}><span>✎</span><span>Profile</span></button>
            </div>
          </header>
          <div className="messages">
            <div className="date-divider"><span>THE STORY SO FAR</span></div>
            {messages.map((message, index) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" && <Avatar character={selected} />}
                <div className="message-stack">
                  <div className="message-meta"><strong>{message.role === "assistant" ? selected.name : activePersona?.name || "You"}</strong><time>{time(message.createdAt)}</time></div>
                  <div className={`bubble ${!message.content && streaming ? "typing" : ""} ${editingMessageId === message.id ? "editing" : ""}`}>
                    {editingMessageId === message.id ? <div className="inline-editor"><textarea autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditingMessageId(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMessageEdit(message,index + 1); } }} /><div><span>Esc to cancel · ⌘/Ctrl + Enter to save</span><button onClick={() => setEditingMessageId(null)}>Cancel</button><button className="save-edit" disabled={!editDraft.trim()} onClick={() => void saveMessageEdit(message,index + 1)}>Save</button></div></div> : <>{message.content ? (message.role === "assistant" ? tokenizeCharacterMessage(message.content).map((segment, segmentIndex) => <span className={`message-segment ${segment.kind}`} key={segmentIndex}>{segment.text}</span>) : message.content) : <><i /><i /><i /></>}{message.role === "assistant" && message.content && message.variants.length > 1 && <div className="variant-picker"><button aria-label="Previous response option" disabled={streaming || message.selectedVariant === 0} onClick={() => void selectVariant(message,message.selectedVariant - 1,index + 1)}>‹</button><span>Option <strong>{message.selectedVariant + 1}</strong> of {message.variants.length}</span><button aria-label="Next response option" disabled={streaming || message.selectedVariant === message.variants.length - 1} onClick={() => void selectVariant(message,message.selectedVariant + 1,index + 1)}>›</button><em>Selected</em></div>}</>}
                  </div>
                  {message.content && !streaming && editingMessageId !== message.id && <div className="message-actions"><button onClick={() => beginEdit(message)}>✎ Edit</button><button onClick={() => void deleteFromMessage(message,index + 1)}>⌫ Delete from here</button>{message.role === "assistant" && <button title="See which durable memories and historical arcs were recalled for this reply" onClick={() => setRecallMessage(message)}>⌁ {message.memoryIds.length + message.arcIds.length ? `${message.memoryIds.length + message.arcIds.length} recalled` : "Context"}</button>}{message.role === "assistant" && index === messages.length - 1 && <><button onClick={() => void send("regenerate")}>↻ Regenerate</button><button className="continue-action" title="Generate the character's next message" onClick={() => void send("continue")}>▶ Continue</button></>}</div>}
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div>
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          <div className="composer-wrap">
            <div className="mode-strip"><span className={selected.nsfwEnabled ? "adult-on" : ""}>{selected.nsfwEnabled ? "18+ adult mode" : "SFW mode"}</span><span>•</span><span>{settings.model} · {activePersona?.name || "You"}</span>{conversation && (conversation.instructionPresets.length > 0 || conversation.customInstructions) && <><span>•</span><span>{conversation.instructionPresets.length + (conversation.customInstructions ? 1 : 0)} instructions</span></>}</div>
            {composerToolsOpen && <div className="composer-tools">
              <button onClick={() => { setStudioStartSection("world"); setEditing(selected); setStudioOpen(true); setComposerToolsOpen(false); }}><span>▤</span><strong>World</strong><small>{selected.worldIds.length} attached</small></button>
              <label><span>◉</span><strong>Persona</strong><select aria-label="Active persona" value={conversation?.personaId || activePersona?.id || ""} onChange={(e) => void updateConversationContext({ personaId: e.target.value || null })}>{personas.map((persona) => <option value={persona.id} key={persona.id}>{persona.name}{persona.isDefault ? " · default" : ""}</option>)}</select></label>
              <button onClick={() => { setInstructionsOpen(true); setComposerToolsOpen(false); }}><span>⌘</span><strong>Instructions</strong><small>{conversation?.instructionPresets.length || 0} selected</small></button>
              <button onClick={() => { setActiveView("profile"); setComposerToolsOpen(false); }}><span>◎</span><strong>Manage personas</strong><small>Create & edit</small></button>
            </div>}
            <div className="composer">
              <button className={`composer-plus ${composerToolsOpen ? "active" : ""}`} aria-label="Chat tools" onClick={() => setComposerToolsOpen((value) => !value)}>{composerToolsOpen ? "×" : "+"}</button>
              <textarea value={composer} onChange={(e) => setComposer(e.target.value)} placeholder={`Message ${selected.name}…`} rows={1} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !window.matchMedia("(max-width: 760px)").matches) { e.preventDefault(); void send(); } }} disabled={streaming} />
              <button className="send-button" aria-label="Send message" disabled={streaming || !composer.trim()} onClick={() => void send()}>↑</button>
            </div>
            <small className="composer-hint"><span className="desktop-composer-hint">Enter to send · Shift + Enter for a new line</span><span className="mobile-composer-hint">Enter for a new line · Tap ↑ to send</span></small>
          </div>
        </section>
      ) : (
        <section className="empty-state"><div className="orb">✦</div><span className="eyebrow">Your private story studio</span><h1>Create someone<br />worth remembering.</h1><p>Shape their history, voice, desires, and boundaries. Afterglow keeps the moments that matter.</p><button className="primary" onClick={() => setStudioOpen(true)}>Create your first character</button></section>
      )}

      {studioOpen && <CharacterStudio character={editing} worlds={worlds} startSection={studioStartSection} onOpenWorldLibrary={() => { setStudioOpen(false); setEditing(null); setActiveView("worlds"); }} onLibrariesChanged={() => void loadLibraries()} onClose={() => { setStudioOpen(false); setEditing(null); }} onSaved={async (character) => { setStudioOpen(false); setEditing(null); await Promise.all([loadCharacters(),loadLibraries()]); setSelectedId(character.id); setActiveView("chats"); }} onDeleted={async () => { setStudioOpen(false); setEditing(null); await loadCharacters(); }} />}
      {memoryOpen && selected && <MemoryDrawer character={selected} conversation={conversation} memories={memories} onClose={() => setMemoryOpen(false)} onChange={async () => { const data = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(selected.id,conversation?.id)); setMemories(data.memories); setMemoryArcs(data.arcs); }} />}
      {historyOpen && selected && <ConversationDrawer character={selected} personas={personas} conversations={conversations} activeId={conversation?.id ?? null} onClose={() => setHistoryOpen(false)} onNew={(greetingIndex,personaId) => void newConversation(greetingIndex,personaId)} onSelect={async (id) => { await loadChat(selected.id,id); setHistoryOpen(false); }} onChange={() => void loadChat(selected.id)} />}
      {settingsOpen && <SettingsDrawer settings={settings} onClose={() => setSettingsOpen(false)} onSaved={(value) => { setSettings(value); setSettingsOpen(false); }} onImported={async () => { await loadCharacters(); const data = await api<{ settings: AppSettings }>("/api/settings"); setSettings(data.settings); }} />}
      {recallMessage && <RecallDrawer message={recallMessage} memories={memories} arcs={memoryArcs} onClose={() => setRecallMessage(null)} />}
      {instructionsOpen && conversation && <InstructionsDrawer conversation={conversation} onClose={() => setInstructionsOpen(false)} onSave={async (changes) => { await updateConversationContext(changes); setInstructionsOpen(false); }} />}
    </main>
  );
}

function Logo() { return <div className="logo"><span className="logo-mark">A</span><span>Afterglow</span></div>; }

function Avatar({ character, large = false }: { character: Character; large?: boolean }) {
  return <div className={`avatar ${large ? "large" : ""}`} style={{ "--accent": character.accent } as React.CSSProperties}>{character.avatarUrl ? <img src={character.avatarUrl} alt="" /> : <span>{initials(character.name)}</span>}</div>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol">◇</div><span className="eyebrow">Private space</span><h1>Welcome back.</h1><p>Enter the password configured for your Afterglow instance.</p><form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(""); try { await api("/api/auth", { method: "POST", body: JSON.stringify({ password }) }); onSuccess(); } catch (err) { setError(err instanceof Error ? err.message : "Login failed"); } finally { setBusy(false); } }}><input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="App password" /><button className="primary" disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock Afterglow"}</button>{error && <small className="form-error">{error}</small>}</form></div></main>;
}

function AgeGate({ onAccept }: { onAccept: () => void }) {
  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol">18+</div><span className="eyebrow">Adults only</span><h1>Before you enter.</h1><p>This private instance can host mature fictional roleplay. You must be at least 18 and of legal age where you live.</p><button className="primary" onClick={onAccept}>I am an adult — continue</button><small>Afterglow prohibits sexual content involving minors, non-consensual exploitation, or real people.</small></div></main>;
}

function CharacterStudio({ character, worlds, startSection, onOpenWorldLibrary, onLibrariesChanged, onClose, onSaved, onDeleted }: { character: Character | null; worlds: WorldWithCount[]; startSection: "identity" | "definition" | "world"; onOpenWorldLibrary: () => void; onLibrariesChanged: () => void; onClose: () => void; onSaved: (character: Character) => void; onDeleted: () => void }) {
  const [form, setForm] = useState<CharacterDraft>(() => characterDraft(character));
  const [idea, setIdea] = useState(""); const [generatorMode, setGeneratorMode] = useState<"idea" | "dump">("idea"); const [tone, setTone] = useState("dramatic");
  const [section, setSection] = useState<"identity" | "definition" | "world">(startSection); const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const field = <K extends keyof CharacterDraft>(key: K, value: CharacterDraft[K]) => setForm((current) => ({ ...current, [key]: value }));
  const openings = [form.greeting, ...form.alternateGreetings];
  async function generate() {
    setBusy(true); setError("");
    try {
      const data = await api<{ character: CharacterDraft }>("/api/characters/generate", { method: "POST", body: JSON.stringify({ idea, mode: generatorMode, tone, nsfwEnabled: form.nsfwEnabled }) });
      setForm(characterDraft({ ...data.character, id: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      setGenerated(true); setSection(data.character.profileType === "ensemble" ? "definition" : "identity");
    } catch (e) { setError(e instanceof Error ? e.message : "Generation failed"); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      let worldIds = [...form.worldIds];
      if (form.lorebook.trim()) {
        const created = await api<{ world: World }>("/api/worlds", { method: "POST", body: JSON.stringify({ name: `${form.name.trim()} world`, description: "World material separated automatically from the character import.", content: form.lorebook.trim() }) });
        worldIds = [...new Set([...worldIds,created.world.id])]; onLibrariesChanged();
      }
      const payload = characterDraft({ ...form, tagline: "", lorebook: "", worldIds, id: character?.id || "draft", createdAt: character?.createdAt || new Date().toISOString(), updatedAt: character?.updatedAt || new Date().toISOString() });
      const data = await api<{ character: Character }>(character ? `/api/characters/${character.id}` : "/api/characters", { method: character ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onSaved(data.character);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); } finally { setBusy(false); }
  }
  function updateCast(index: number, key: "name" | "role" | "description", value: string) {
    field("cast", form.cast.map((member, memberIndex) => memberIndex === index ? { ...member, [key]: value } : member));
  }
  function updateOpening(index: number, value: string) {
    if (index === 0) field("greeting", value);
    else field("alternateGreetings", form.alternateGreetings.map((opening, openingIndex) => openingIndex === index - 1 ? value : opening));
  }
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><section className="studio modal"><header><div><span className="eyebrow">{character ? "Character details" : "Character studio"}</span><h2>{character ? `View or edit ${character.name}` : "Bring someone to life"}</h2></div><button className="icon-button" onClick={onClose}>×</button></header>
    {!character && <div className="generator"><div className="generator-tabs"><button className={generatorMode === "idea" ? "active" : ""} onClick={() => setGeneratorMode("idea")}>Quick idea</button><button className={generatorMode === "dump" ? "active" : ""} onClick={() => setGeneratorMode("dump")}>Paste everything</button></div><div><label>{generatorMode === "dump" ? "Dump all your character material" : "Start with an idea"}<small>{generatorMode === "dump" ? "Paste up to 100,000 characters. Afterglow detects multiple-character cards, separates reusable world material, creates opening options, and keeps the untouched source for review." : "Describe one character or a complete cast/story concept."}</small></label><textarea maxLength={100000} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder={generatorMode === "dump" ? "Paste the complete card, descriptions, dialogue, scenarios, lorebooks, rules, and notes here…" : "A sharp-witted art thief in her thirties who meets me at a rain-soaked Paris café…"} rows={generatorMode === "dump" ? 12 : 3} /></div><div className="generator-row"><select value={tone} onChange={(e) => setTone(e.target.value)}><option value="dramatic">Dramatic</option><option value="romantic">Romantic</option><option value="playful">Playful</option><option value="adventurous">Adventurous</option><option value="comforting">Comforting</option><option value="custom">Preserve supplied tone</option></select><span className="character-count">{idea.length.toLocaleString()} / 100,000</span><button className="magic-button" disabled={busy || idea.trim().length < 8} onClick={() => void generate()}>✦ {busy ? (generatorMode === "dump" ? "Mapping characters & worlds…" : "Dreaming…") : (generatorMode === "dump" ? "Import and organize" : "Generate profile")}</button></div></div>}
    <div className="character-card-preview"><Avatar character={{ ...form, id: "preview", createdAt: "", updatedAt: "" }} large /><div><span className="eyebrow">{form.profileType === "ensemble" ? "Multiple characters" : "Character card"}</span><strong>{form.name || "Untitled character"}</strong><p>{form.profileType === "ensemble" ? `${form.cast.length} recurring characters` : "Single-character roleplay"}</p><div><span>{form.cast.length} cast</span><span>{openings.filter(Boolean).length} openings</span><span>{form.worldIds.length + (form.lorebook.trim() ? 1 : 0)} worlds</span></div></div></div>
    {generated && <div className="import-summary"><strong>Import mapped without discarding the source.</strong><span>{form.profileType === "ensemble" ? "Multiple characters detected" : "Single character detected"} · {form.cast.length} cast entries · {openings.filter(Boolean).length} openings · {form.sourceMaterial.length.toLocaleString()} source characters retained</span></div>}
    <nav className="studio-sections"><button className={section === "identity" ? "active" : ""} onClick={() => setSection("identity")}>General</button><button className={section === "definition" ? "active" : ""} onClick={() => setSection("definition")}>Definition</button><button className={section === "world" ? "active" : ""} onClick={() => setSection("world")}>World & openings</button></nav>
    <div className="form-grid">
      {character && <div className="profile-note wide"><span>Complete saved profile</span><p>Saving updates future replies without deleting existing chats or memories. Imported source is retained separately from the chat prompt.</p></div>}
      {section === "identity" && <>
        <label>Card type<select value={form.profileType} onChange={(e) => field("profileType", e.target.value as CharacterDraft["profileType"])}><option value="single">Single character</option><option value="ensemble">Multiple characters</option></select></label><label>Accent<input type="color" value={form.accent} onChange={(e) => field("accent", e.target.value)} /></label>
        <label className="wide">Character name<input value={form.name} onChange={(e) => field("name", e.target.value)} placeholder={form.profileType === "ensemble" ? "The Wayfarers · Tower of Babel" : "Character name"} /></label>
        <div className="avatar-source wide"><div><strong>Character image</strong><small>Upload from your media library or use a direct image link.</small></div><div className="avatar-source-actions"><label className="secondary file-button">↑ Choose image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async (e) => { const file=e.target.files?.[0]; if(!file) return; try { field("avatarUrl",await imageFileData(file)); } catch(err) { setError(err instanceof Error ? err.message : "Image import failed"); } finally { e.target.value=""; } }} /></label>{form.avatarUrl && <button className="secondary" onClick={() => field("avatarUrl","")}>Remove</button>}</div><input aria-label="Character image URL" value={form.avatarUrl.startsWith("data:") ? "" : form.avatarUrl} onChange={(e) => field("avatarUrl", e.target.value)} placeholder="https://… (optional)" /></div>
        <label className="toggle-row wide"><span><strong>Adult mode</strong><small>Allows consensual explicit roleplay between fictional adults.</small></span><input type="checkbox" checked={form.nsfwEnabled} onChange={(e) => field("nsfwEnabled", e.target.checked)} /></label>
      </>}
      {section === "definition" && <>
        <label className="wide">Backstory & durable premise<textarea value={form.backstory} onChange={(e) => field("backstory", e.target.value)} rows={fieldRows(form.backstory, 7)} placeholder="History, relationships, formative events, timeline…" /></label>
        <label className="wide">Personality & mannerisms<textarea value={form.personality} onChange={(e) => field("personality", e.target.value)} rows={fieldRows(form.personality, 6)} /></label>
        <section className="structured-editor wide"><div className="structured-heading"><span><strong>Structured cast</strong><small>Each recurring character stays distinct instead of being compressed into one lead.</small></span><button className="secondary" onClick={() => field("cast", [...form.cast, { name: "", role: "", description: "" }])}>＋ Add cast member</button></div>{form.cast.map((member, index) => <article key={index}><div><input value={member.name} onChange={(e) => updateCast(index, "name", e.target.value)} placeholder="Name" /><input value={member.role} onChange={(e) => updateCast(index, "role", e.target.value)} placeholder="Role / relationship" /><button aria-label={`Remove ${member.name || "cast member"}`} onClick={() => field("cast", form.cast.filter((_, memberIndex) => memberIndex !== index))}>×</button></div><textarea value={member.description} onChange={(e) => updateCast(index, "description", e.target.value)} rows={fieldRows(member.description, 4, 12)} placeholder="Appearance, personality, motives, abilities, relationships, progression, voice…" /></article>)}</section>
        <label className="wide">Example dialogue & voice<textarea value={form.exampleDialogue} onChange={(e) => field("exampleDialogue", e.target.value)} rows={fieldRows(form.exampleDialogue, 5)} /></label><label className="wide">Response directive<textarea value={form.responseDirective} onChange={(e) => field("responseDirective", e.target.value)} rows={fieldRows(form.responseDirective, 5)} placeholder="Voice, length, initiative, point of view, NPC handling…" /></label><label className="wide">Boundaries<textarea value={form.boundaries} onChange={(e) => field("boundaries", e.target.value)} rows={fieldRows(form.boundaries, 4)} placeholder="Consent rules, topics to avoid, hard limits…" /></label>
      </>}
      {section === "world" && <>
        <label className="wide">Opening scenario<textarea value={form.scenario} onChange={(e) => field("scenario", e.target.value)} rows={fieldRows(form.scenario, 6)} /></label>
        <section className="structured-editor world-picker wide"><div className="structured-heading"><span><strong>Attached worlds</strong><small>Reusable world documents can be attached to any number of characters.</small></span><button className="secondary" onClick={onOpenWorldLibrary}>Open World library</button></div>{worlds.length ? worlds.map((world) => <label key={world.id} className={form.worldIds.includes(world.id) ? "selected" : ""}><input type="checkbox" checked={form.worldIds.includes(world.id)} onChange={(e) => field("worldIds",e.target.checked ? [...form.worldIds,world.id] : form.worldIds.filter((id) => id !== world.id))} /><span><strong>{world.name}</strong><small>{world.description || `${world.content.length.toLocaleString()} characters of world canon`}</small></span></label>) : <div className="empty-library-note">No reusable worlds yet. Create one in the World library, then attach it here.</div>}</section>
        {form.lorebook.trim() && <label className="wide staged-world">Imported world draft <span>This was extracted by Auto Fill. Saving creates it as a separate reusable World and attaches it here.</span><textarea value={form.lorebook} onChange={(e) => field("lorebook",e.target.value)} rows={fieldRows(form.lorebook,8,20)} /></label>}
        <section className="structured-editor openings-editor wide"><div className="structured-heading"><span><strong>Initial message options</strong><small>The first is the default. Every new chat can choose any opening.</small></span><button className="secondary" onClick={() => field("alternateGreetings", [...form.alternateGreetings, ""])} disabled={form.alternateGreetings.length >= 11}>＋ Add opening</button></div>{openings.map((opening, index) => <article key={index}><div><strong>Opening {index + 1}{index === 0 ? " · default" : ""}</strong>{index > 0 && <button aria-label={`Remove opening ${index + 1}`} onClick={() => field("alternateGreetings", form.alternateGreetings.filter((_, openingIndex) => openingIndex !== index - 1))}>×</button>}</div><textarea value={opening} onChange={(e) => updateOpening(index, e.target.value)} rows={fieldRows(opening, 5, 14)} placeholder="An immersive first message with action and dialogue…" /></article>)}</section>
        <label className="wide source-material">Original import source <span>Preserved verbatim for review and future re-imports; it is not sent with every chat reply.</span><textarea value={form.sourceMaterial} onChange={(e) => field("sourceMaterial", e.target.value)} rows={8} placeholder="The untouched paste will be stored here after an import." /></label>
      </>}
    </div>
    {error && <div className="form-error">{error}</div>}<footer>{character && <button className="danger-button" disabled={busy} onClick={async () => { if (!window.confirm(`Permanently delete ${character.name}, including every chat and memory attached to them?`)) return; setBusy(true); try { await api(`/api/characters/${character.id}`, { method: "DELETE" }); onDeleted(); } catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); setBusy(false); } }}>⌫ Delete character</button>}<span className="footer-spacer" /><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>{busy ? "Saving…" : character ? "Save changes" : "Create character"}</button></footer>
  </section></div>;
}

function MemoryDrawer({ character, conversation, memories, onClose, onChange }: { character: Character; conversation: Conversation | null; memories: Memory[]; onClose: () => void; onChange: () => void }) {
  const [content, setContent] = useState(""); const [keywords, setKeywords] = useState(""); const [scope,setScope] = useState<"chat"|"character">("chat"); const [busy, setBusy] = useState(false);
  async function updateMemory(memory: Memory, changes: Partial<Pick<Memory,"content"|"kind"|"importance"|"keywords"|"pinned"|"status"|"resolution">>) {
    await api(`/api/memories?id=${memory.id}`,{method:"PATCH",body:JSON.stringify({content:memory.content,kind:memory.kind,importance:memory.importance,keywords:memory.keywords,pinned:memory.pinned,status:memory.status,resolution:memory.resolution,...changes})});
    onChange();
  }
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer"><header><div><span className="eyebrow">Continuity</span><h2>{character.name}&apos;s memories</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="memory-explainer"><span>⌁</span><p>Generated memories belong only to this chat. Active promises and open loops receive protected recall; resolved ones remain in the permanent archive.</p>{conversation && <button disabled={busy || conversation.messageCount < 2} onClick={async () => { setBusy(true); try { await api("/api/memories/consolidate",{method:"POST",body:JSON.stringify({conversationId:conversation.id})}); onChange(); } finally { setBusy(false); } }}>{busy?"Remembering…":"Refresh now"}</button>}</div>{conversation?.summary && <section className="summary-card"><span className="eyebrow">Rolling story-so-far · this chat</span><p>{conversation.summary}</p></section>}<div className="memory-list">{memories.map((memory) => <article key={memory.id} className={`memory-card memory-${memory.status}`}><div><span className={`memory-pin ${memory.pinned ? "pinned" : ""}`}>{memory.pinned ? "◆ Pinned" : `Importance ${memory.importance}/5`} · {memory.conversationId ? "This chat" : "All chats"} · {memory.status}</span><span className="memory-controls"><select aria-label="Memory type" value={memory.kind} onChange={(e) => void updateMemory(memory,{kind:e.target.value as Memory["kind"]})}><option value="identity">Identity</option><option value="relationship">Relationship</option><option value="event">Event</option><option value="promise">Promise</option><option value="preference">Preference</option><option value="boundary">Boundary</option><option value="open_loop">Open loop</option></select>{(memory.kind === "promise" || memory.kind === "open_loop") && <select aria-label="Memory status" value={memory.status} onChange={(e) => void updateMemory(memory,{status:e.target.value as Memory["status"],resolution:e.target.value === "active" ? "" : memory.resolution})}><option value="active">Active</option><option value="resolved">Resolved</option><option value="superseded">Superseded</option></select>}<button onClick={() => void updateMemory(memory,{pinned:!memory.pinned})}>{memory.pinned?"Unpin":"Pin"}</button><button onClick={() => { const value=window.prompt("Edit memory",memory.content)?.trim(); if(value&&value!==memory.content) void updateMemory(memory,{content:value}); }}>Edit</button><button onClick={async () => { if(!window.confirm("Delete this memory?")) return; await api(`/api/memories?id=${memory.id}`, { method: "DELETE" }); onChange(); }}>Delete</button></span></div><p>{memory.content}</p>{memory.resolution && <p className="memory-resolution">Resolved: {memory.resolution}</p>}{memory.keywords.length > 0 && <small>{memory.keywords.map((key) => `#${key}`).join("  ")}</small>}</article>)}</div><form className="memory-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("/api/memories", { method: "POST", body: JSON.stringify({ characterId: character.id, conversationId: scope === "chat" ? conversation?.id ?? null : null, content, kind:"event", keywords: keywords.split(",").map((x) => x.trim()).filter(Boolean), importance: 5, pinned: true }) }); setContent(""); setKeywords(""); onChange(); } finally { setBusy(false); } }}><span className="eyebrow">Add pinned journal</span><label>Use in<select value={scope} onChange={(e) => setScope(e.target.value as "chat"|"character")}><option value="chat">This chat only</option><option value="character">All chats with this character</option></select></label><textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="A fact, promise, preference, or piece of lore…" rows={3} /><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="Recall keywords, comma separated" /><button className="primary" disabled={busy || !content.trim()}>Add to memory</button></form></aside></div>;
}

function RecallDrawer({ message, memories, arcs, onClose }: { message: Message; memories: Memory[]; arcs: MemoryArc[]; onClose: () => void }) {
  const recalled = message.memoryIds.map((id) => memories.find((memory) => memory.id === id)).filter((memory): memory is Memory => Boolean(memory));
  const recalledArcs = message.arcIds.map((id) => arcs.find((arc) => arc.id === id)).filter((arc): arc is MemoryArc => Boolean(arc));
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer recall-drawer"><header><div><span className="eyebrow">Reply context</span><h2>What this reply remembered</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="memory-explainer"><span>⌁</span><p>Every reply also receives the complete character profile, current rolling summary, and recent transcript. Below are the additional durable memories and historical chapters recalled from the permanent archive.</p></div><div className="memory-list">{recalled.map((memory) => <article className="memory-card" key={memory.id}><div><span className="memory-pin">{memory.kind.replace("_"," ")} · {memory.status} · importance {memory.importance}/5</span></div><p>{memory.content}</p>{memory.resolution && <p className="memory-resolution">Resolution: {memory.resolution}</p>}</article>)}{recalledArcs.map((arc) => <article className="memory-card" key={arc.id}><div><span className="memory-pin">Historical arc · messages {arc.startMessageCount}–{arc.endMessageCount}</span></div><p>{arc.summary}</p></article>)}{!recalled.length && !recalledArcs.length && <section className="summary-card"><span className="eyebrow">No separate archive recall</span><p>Character canon, rolling continuity, and the recent transcript were still included. Older replies created before archive tracing will also show this message.</p></section>}</div></aside></div>;
}

function ConversationDrawer({ character, personas, conversations, activeId, onClose, onNew, onSelect, onChange }: { character: Character; personas: Persona[]; conversations: Conversation[]; activeId: string | null; onClose: () => void; onNew: (greetingIndex: number, personaId: string | null) => void; onSelect: (id: string) => void; onChange: () => void }) {
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [personaId,setPersonaId] = useState(personas.find((item) => item.isDefault)?.id ?? personas[0]?.id ?? "");
  const greetings = [character.greeting, ...character.alternateGreetings].map((text,index) => ({ text,index })).filter((item) => item.text.trim());
  const selectedGreeting = greetings.find((item) => item.index === greetingIndex) ?? greetings[0];
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer conversation-drawer"><header><div><span className="eyebrow">Chat history</span><h2>Stories with {character.name}</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="drawer-action">{greetings.length > 1 && <label className="opening-picker">Start from<select value={selectedGreeting?.index ?? 0} onChange={(e) => setGreetingIndex(Number(e.target.value))}>{greetings.map((item,position) => <option value={item.index} key={item.index}>Opening {position + 1}{item.index === 0 ? " · default" : ""}</option>)}</select><span>{compactMessagePreview(selectedGreeting?.text || "", 150)}</span></label>}<label className="opening-picker">Chat as<select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>{personas.map((persona) => <option value={persona.id} key={persona.id}>{persona.name}{persona.isDefault ? " · default" : ""}</option>)}</select></label><button className="primary" onClick={() => onNew(selectedGreeting?.index ?? 0,personaId || null)}>＋ Start separate story</button><p>Starts a completely separate story with its own persona, instructions, and memories.</p></div><div className="conversation-list">{conversations.map((item) => <article key={item.id} className={`conversation-card ${item.id === activeId ? "active" : ""}`}><button className="conversation-main" onClick={() => onSelect(item.id)}><strong>{item.title}</strong><span>{item.messageCount} messages · {personas.find((persona) => persona.id === item.personaId)?.name || "Default persona"} · {new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(new Date(item.updatedAt))}</span></button><div><button title="Rename" onClick={async () => { const title = window.prompt("Conversation title",item.title)?.trim(); if (!title || title === item.title) return; await api(`/api/conversations/${item.id}`,{method:"PATCH",body:JSON.stringify({title})}); onChange(); }}>✎</button><button title="Delete" onClick={async () => { if (!window.confirm(`Delete “${item.title}” and its chat-specific memories? All-chats journal entries will remain.`)) return; await api(`/api/conversations/${item.id}`,{method:"DELETE"}); onChange(); }}>⌫</button></div></article>)}</div></aside></div>;
}

function HomeFeed({ characters, onOpen, onCreate }: { characters: Character[]; onOpen: (character: Character) => void; onCreate: () => void }) {
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Your private library</span><h1>Home</h1><p>Characters and stories ready to continue.</p></div><button className="primary" onClick={onCreate}>＋ Create character</button></header><div className="feed-grid">{characters.map((character) => <button key={character.id} className="feed-card" onClick={() => onOpen(character)}><div className="feed-card-art" style={{ "--accent": character.accent } as React.CSSProperties}>{character.avatarUrl ? <img src={character.avatarUrl} alt="" /> : <span>{initials(character.name)}</span>}<em>{character.nsfwEnabled ? "18+" : "SFW"}</em></div><div><span className="eyebrow">{character.profileType === "ensemble" ? "Multiple characters" : "Character"}</span><strong>{character.name}</strong><small>{character.cast.length ? `${character.cast.length} cast members` : `${character.worldIds.length} attached worlds`} · {character.alternateGreetings.length + (character.greeting ? 1 : 0)} openings</small></div></button>)}{!characters.length && <div className="empty-library-note">Your character feed is empty. Create or import your first card to begin.</div>}</div></section>;
}

function PlaceholderView({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <section className="placeholder-view"><span>{icon}</span><h1>{title}</h1><p>{text}</p></section>;
}

function WorldLibrary({ worlds, onChange }: { worlds: WorldWithCount[]; onChange: () => void }) {
  const [editing,setEditing] = useState<World | null | "new">(null); const [name,setName] = useState(""); const [description,setDescription] = useState(""); const [content,setContent] = useState(""); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  function open(world?: World) { setEditing(world ?? "new"); setName(world?.name ?? ""); setDescription(world?.description ?? ""); setContent(world?.content ?? ""); setError(""); }
  async function save() { setBusy(true); setError(""); try { await api(editing === "new" ? "/api/worlds" : `/api/worlds/${editing!.id}`,{method:editing === "new"?"POST":"PATCH",body:JSON.stringify({name,description,content})}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Could not save world"); } finally { setBusy(false); } }
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Reusable canon</span><h1>World</h1><p>Write lore once, then attach the same document to any characters that live there.</p></div><button className="primary" onClick={() => open()}>＋ New world</button></header><div className="document-grid">{worlds.map((world) => <article key={world.id} className="document-card"><span className="document-icon">▤</span><div><strong>{world.name}</strong><p>{world.description || compactMessagePreview(world.content,140)}</p><small>{world.content.length.toLocaleString()} characters · used by {world.characterCount ?? 0} cards</small></div><button onClick={() => open(world)}>Edit</button></article>)}{!worlds.length && <div className="empty-library-note">No worlds yet. Create lore, rules, locations, factions, or setting documents here.</div>}</div>{editing && <div className="modal-backdrop" onMouseDown={(e) => { if(e.currentTarget===e.target)setEditing(null); }}><section className="modal document-editor"><header><div><span className="eyebrow">World document</span><h2>{editing === "new" ? "Create a reusable world" : `Edit ${editing.name}`}</h2></div><button className="icon-button" onClick={() => setEditing(null)}>×</button></header><div className="document-form"><label>World name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tower of Babel" /></label><label>Short description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Setting, rules, factions, locations…" /></label><label>World canon<textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} maxLength={100000} placeholder="Everything characters should consistently know about this world…" /></label><small>{content.length.toLocaleString()} / 100,000</small>{error && <div className="form-error">{error}</div>}</div><footer>{editing !== "new" && <button className="danger-button" disabled={busy} onClick={async () => { if(!window.confirm(`Delete “${editing.name}”? It will detach from every character.`))return; setBusy(true); try { await api(`/api/worlds/${editing.id}`,{method:"DELETE"}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Delete failed"); setBusy(false); } }}>⌫ Delete</button>}<span className="footer-spacer"/><button className="secondary" onClick={() => setEditing(null)}>Cancel</button><button className="primary" disabled={busy||!name.trim()||!content.trim()} onClick={() => void save()}>{busy?"Saving…":"Save world"}</button></footer></section></div>}</section>;
}

function PersonaLibrary({ personas, onChange }: { personas: Persona[]; onChange: () => void }) {
  const [editing,setEditing] = useState<Persona | null | "new">(null); const [name,setName] = useState(""); const [description,setDescription] = useState(""); const [avatarUrl,setAvatarUrl] = useState(""); const [accent,setAccent] = useState("#e879a9"); const [isDefault,setIsDefault] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  function open(persona?: Persona) { setEditing(persona ?? "new"); setName(persona?.name ?? ""); setDescription(persona?.description ?? ""); setAvatarUrl(persona?.avatarUrl ?? ""); setAccent(persona?.accent ?? "#e879a9"); setIsDefault(persona?.isDefault ?? personas.length === 0); setError(""); }
  async function save() { setBusy(true); setError(""); try { await api(editing === "new"?"/api/personas":`/api/personas/${editing!.id}`,{method:editing === "new"?"POST":"PATCH",body:JSON.stringify({name,description,avatarUrl,accent,isDefault})}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Could not save persona"); } finally { setBusy(false); } }
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Who you enter the story as</span><h1>Personas</h1><p>Create different identities, appearances, pronouns, and backgrounds, then choose one independently for every chat.</p></div><button className="primary" onClick={() => open()}>＋ New persona</button></header><div className="persona-grid">{personas.map((persona) => <button key={persona.id} className="persona-card" onClick={() => open(persona)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available for any chat"}</small><p>{compactMessagePreview(persona.description||"No profile details yet.",120)}</p></span></button>)}</div>{editing && <div className="modal-backdrop" onMouseDown={(e) => { if(e.currentTarget===e.target)setEditing(null); }}><section className="modal document-editor persona-editor"><header><div><span className="eyebrow">Persona</span><h2>{editing === "new"?"Create yourself for a story":`Edit ${editing.name}`}</h2></div><button className="icon-button" onClick={() => setEditing(null)}>×</button></header><div className="document-form"><div className="persona-image-row"><div className="persona-preview" style={{"--accent":accent} as React.CSSProperties}>{avatarUrl?<img src={avatarUrl} alt=""/>:<span>{initials(name)}</span>}</div><label className="secondary file-button">↑ Choose image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;try{setAvatarUrl(await imageFileData(file));}catch(err){setError(err instanceof Error?err.message:"Image import failed");}finally{e.target.value="";}}}/></label><input type="color" aria-label="Persona accent" value={accent} onChange={(e)=>setAccent(e.target.value)}/></div><label>Persona name<input value={name} onChange={(e)=>setName(e.target.value)} placeholder="Name used in chat"/></label><label>Persona description<textarea value={description} onChange={(e)=>setDescription(e.target.value)} rows={10} placeholder="Appearance, pronouns, age, personality, abilities, history, relationships, and anything characters should know…"/></label><label className="toggle-row"><span><strong>Default persona</strong><small>Automatically selected for new chats.</small></span><input type="checkbox" checked={isDefault} onChange={(e)=>setIsDefault(e.target.checked)}/></label>{error&&<div className="form-error">{error}</div>}</div><footer>{editing!=="new"&&<button className="danger-button" disabled={busy||editing.isDefault} title={editing.isDefault?"Choose another default persona first":"Delete persona"} onClick={async()=>{if(!window.confirm(`Delete persona “${editing.name}”? Existing chats will fall back to your default persona.`))return;setBusy(true);try{await api(`/api/personas/${editing.id}`,{method:"DELETE"});setEditing(null);onChange();}catch(e){setError(e instanceof Error?e.message:"Delete failed");setBusy(false);}}}>⌫ Delete</button>}<span className="footer-spacer"/><button className="secondary" onClick={()=>setEditing(null)}>Cancel</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void save()}>{busy?"Saving…":"Save persona"}</button></footer></section></div>}</section>;
}

function PersonaAvatar({ persona }: { persona: Persona }) { return <div className="persona-preview" style={{"--accent":persona.accent} as React.CSSProperties}>{persona.avatarUrl?<img src={persona.avatarUrl} alt=""/>:<span>{initials(persona.name)}</span>}</div>; }

function InstructionsDrawer({ conversation, onClose, onSave }: { conversation: Conversation; onClose: () => void; onSave: (value: { instructionPresets: ChatInstructionPreset[]; customInstructions: string }) => Promise<void> }) {
  const [presets,setPresets] = useState<ChatInstructionPreset[]>(conversation.instructionPresets); const [custom,setCustom] = useState(conversation.customInstructions); const [busy,setBusy] = useState(false);
  const choices: { id: ChatInstructionPreset; title: string; text: string }[] = [
    {id:"reduce_repetition",title:"Reduce repetition",text:"Avoid recycled phrases, gestures, and emotional beats."},
    {id:"stay_focused",title:"Stay focused",text:"Keep replies centered on the latest message and immediate scene."},
    {id:"advance_plot",title:"Advance the plot",text:"Add natural consequences, discoveries, or complications when appropriate."},
  ];
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e)=>{if(e.currentTarget===e.target)onClose();}}><aside className="memory-drawer instruction-drawer"><header><div><span className="eyebrow">This chat only</span><h2>Instructions</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="instruction-body"><p>These directions are added beneath the character, world, persona, and continuity context for this story only.</p>{choices.map((choice)=><label key={choice.id} className={presets.includes(choice.id)?"selected":""}><input type="checkbox" checked={presets.includes(choice.id)} onChange={(e)=>setPresets(e.target.checked?[...presets,choice.id]:presets.filter((item)=>item!==choice.id))}/><span><strong>{choice.title}</strong><small>{choice.text}</small></span></label>)}<label className="custom-instruction">Custom instruction<textarea rows={7} maxLength={3000} value={custom} onChange={(e)=>setCustom(e.target.value)} placeholder="For example: Keep replies concise during dialogue-heavy scenes…"/><small>{custom.length.toLocaleString()} / 3,000</small></label></div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={async()=>{setBusy(true);await onSave({instructionPresets:presets,customInstructions:custom});setBusy(false);}}>{busy?"Saving…":"Save instructions"}</button></footer></aside></div>;
}

function SettingsDrawer({ settings, onClose, onSaved, onImported }: { settings: AppSettings; onClose: () => void; onSaved: (settings: AppSettings) => void; onImported: () => void }) {
  const [form,setForm] = useState(settings); const [usage,setUsage] = useState<UsageResponse | null>(null); const [busy,setBusy] = useState(false); const [error,setError] = useState(""); const [notice,setNotice] = useState("");
  useEffect(() => { api<UsageResponse>("/api/usage").then(setUsage).catch(() => undefined); }, []);
  const number = (value: number) => new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(value);
  const usd = (value: number) => new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",minimumFractionDigits:value < 0.01 ? 5 : 2,maximumFractionDigits:value < 0.01 ? 6 : 4}).format(value);
  const usageLabels: Record<string,string> = { chat:"Replies",regenerate:"Regenerations",continue:"Continuations",memory_consolidation:"Memory updates",character_generation:"Character generation/import" };
  async function save() { setBusy(true); setError(""); try { const data = await api<{settings:AppSettings}>("/api/settings",{method:"PATCH",body:JSON.stringify(form)}); onSaved(data.settings); } catch (e) { setError(e instanceof Error ? e.message : "Could not save settings"); setBusy(false); } }
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer settings-drawer">
    <header><div><span className="eyebrow">Instance settings</span><h2>Make it yours</h2></div><button className="icon-button" onClick={onClose}>×</button></header>
    <div className="settings-body">
      <section><span className="eyebrow">Your identity</span><label>Your name<input value={form.ownerName} onChange={(e) => setForm({...form,ownerName:e.target.value})} /></label><label>Profile the characters should know<textarea rows={4} value={form.ownerProfile} onChange={(e) => setForm({...form,ownerProfile:e.target.value})} placeholder="Preferences, appearance, pronouns, relationship context…" /></label></section>
      <section><span className="eyebrow">Model & response</span><label>DeepSeek model<input list="models" value={form.model} onChange={(e) => setForm({...form,model:e.target.value})} /><datalist id="models"><option value="deepseek-v4-flash" /><option value="deepseek-v4-pro" /></datalist></label><label>Roleplay preset<select value={form.roleplayPreset} onChange={(e) => setForm({...form,roleplayPreset:e.target.value as AppSettings["roleplayPreset"]})}><option value="immersive">Immersive — adaptive all-rounder</option><option value="raw">Raw adult — direct and autonomous</option><option value="cinematic">Cinematic — atmospheric and dramatic</option><option value="deliberate">Deliberate — logical and complex</option></select></label><p className="setting-note">Raw Adult is the least sanitized when a character&apos;s Adult mode is enabled. Deliberate uses DeepSeek thinking mode; temperature is ignored by the provider in that preset.</p><div className="settings-pair"><label>Creativity <input type="number" min="0" max="2" step="0.05" value={form.temperature} onChange={(e) => setForm({...form,temperature:Number(e.target.value)})} /></label><label>Max reply tokens <input type="number" min="256" max="8000" step="128" value={form.maxTokens} onChange={(e) => setForm({...form,maxTokens:Number(e.target.value)})} /></label></div></section>
      <section><span className="eyebrow">Memory tuning</span><div className="settings-pair"><label>Recent messages <input type="number" min="8" max="100" value={form.contextMessages} onChange={(e) => setForm({...form,contextMessages:Number(e.target.value)})} /></label><label>Recent context tokens <input type="number" min="4000" max="100000" step="1000" value={form.contextTokenBudget} onChange={(e) => setForm({...form,contextTokenBudget:Number(e.target.value)})} /></label><label>Relevant event slots <input type="number" min="1" max="20" value={form.memoryLimit} onChange={(e) => setForm({...form,memoryLimit:Number(e.target.value)})} /></label><label>Memory context tokens <input type="number" min="1000" max="30000" step="500" value={form.memoryTokenBudget} onChange={(e) => setForm({...form,memoryTokenBudget:Number(e.target.value)})} /></label><label>Consolidate every N messages <input type="number" min="6" max="50" value={form.consolidationInterval} onChange={(e) => setForm({...form,consolidationInterval:Number(e.target.value)})} /></label></div><p className="setting-note">The permanent archive has no reply-count cap. The token budget controls how much is recalled at once; active promises, boundaries, and unresolved loops get protected priority. Only journal entries marked “All chats” cross story boundaries.</p></section>
      {usage && <section><span className="eyebrow">Complete usage & cost ledger</span><div className="usage-grid"><div><strong>{number(usage.usage.requests)}</strong><small>API calls</small></div><div><strong>{number(usage.usage.promptTokens)}</strong><small>input tokens</small></div><div><strong>{number(usage.usage.completionTokens)}</strong><small>output tokens</small></div><div><strong>{number(usage.usage.cacheHitTokens)}</strong><small>cached input</small></div><div><strong>{usd(usage.usage.estimatedCostUsd)}</strong><small>estimated cost</small></div></div><div className="usage-breakdown">{usage.byType.map((item) => <div key={item.key}><span><strong>{usageLabels[item.key] ?? item.key}</strong><small>{item.requests} calls · {number(item.promptTokens + item.completionTokens)} tokens</small></span><b>{usd(item.estimatedCostUsd)}</b></div>)}</div><div className="usage-models">{usage.byModel.map((item) => <span key={item.key}>{item.key}: <strong>{usd(item.estimatedCostUsd)}</strong></span>)}</div><p className="setting-note">Includes replies, regenerate, continue, memory consolidation/Refresh now, and character generation/import. Estimates use exact provider-reported cache-hit, cache-miss, and output tokens with DeepSeek prices checked {usage.pricingAsOf}; previously recorded chat events were backfilled.</p></section>}
      <section><span className="eyebrow">Backup & portability</span><div className="data-actions"><a className="secondary" href="/api/backup" download>↓ Export JSON backup</a><label className="secondary file-button">↑ Import backup<input type="file" accept="application/json,.json" onChange={async (e) => { const file=e.target.files?.[0]; if(!file) return; if(!window.confirm("Import this backup as additional characters and chats?")) return; setBusy(true); setError(""); try { const result=await api<{imported:Record<string,number>}>("/api/backup",{method:"POST",body:await file.text()}); setNotice(`Imported ${result.imported.characters} characters and ${result.imported.messages} messages.`); await onImported(); } catch(err) { setError(err instanceof Error?err.message:"Import failed"); } finally { setBusy(false); e.target.value=""; } }} /></label></div><p className="setting-note">Backups include profiles, chats, memories, and these settings—never passwords or API keys.</p></section>
      {notice && <div className="success-note">{notice}</div>}{error && <div className="form-error">{error}</div>}
    </div>
    <footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void save()}>{busy?"Working…":"Save settings"}</button></footer>
  </aside></div>;
}
