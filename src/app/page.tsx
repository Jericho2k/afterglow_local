"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {useRouter} from "next/navigation";
import type { AppSettings, Character, ChatInstructionPreset, Conversation, Memory, MemoryArc, Message, ModelCatalog, Persona, Profile, UsageResponse, World } from "@/lib/types";
import { compactMessagePreview, tokenizeCharacterMessage } from "@/lib/message-format";
import { supabaseBrowser, supabaseBrowserConfigured } from "@/lib/supabase/client";
import { avatarObjectPath, avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { closeStorySurface, closedStoryNavigation, openChatChild, openStory, openStoryChild, type StoryChild } from "@/lib/story-navigation";

type CharacterDraft = Omit<Character, "id" | "createdAt" | "updatedAt" | "ownedByViewer" | "likeCount" | "likedByViewer" | "creator">;
type WorldWithCount = World & { characterCount?: number };
type AppView = "home" | "chats" | "chat" | "worlds" | "personas" | "profile" | "likes";

const blankCharacter: CharacterDraft = {
  name: "", profileType: "single", tagline: "", avatarUrl: "", avatarPath: "", accent: "#e879a9", backstory: "", cast: [], lorebook: "", personality: "", scenario: "",
  greeting: "", alternateGreetings: [], exampleDialogue: "", responseDirective: "", boundaries: "", sourceMaterial: "", worldIds: [], visibility: "private", nsfwEnabled: false,
};

function characterDraft(character?: Character | null): CharacterDraft {
  if (!character) return { ...blankCharacter, cast: [], alternateGreetings: [], worldIds: [] };
  return {
    name: character.name, profileType: character.profileType, tagline: character.tagline, avatarUrl: character.avatarUrl, avatarPath: character.avatarPath, accent: character.accent,
    backstory: character.backstory, cast: character.cast.map((member) => ({ ...member })), lorebook: character.lorebook, personality: character.personality,
    scenario: character.scenario, greeting: character.greeting, alternateGreetings: [...character.alternateGreetings], exampleDialogue: character.exampleDialogue,
    responseDirective: character.responseDirective, boundaries: character.boundaries, sourceMaterial: character.sourceMaterial, worldIds: [...character.worldIds],
    visibility: character.visibility, nsfwEnabled: character.nsfwEnabled,
  };
}

function fieldRows(value: string, minimum: number, maximum = 18) { return Math.min(maximum, Math.max(minimum, Math.ceil(value.length / 420))); }

const defaultSettings: AppSettings = {
  ownerName: "You", ownerProfile: "", providerId: "deepseek", model: "deepseek-v4-flash", roleplayPreset: "immersive", responseLength: "natural", temperature: 0.95, maxTokens: 1800,
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
/**
 * Uploads an avatar to Supabase Storage and returns its object path.
 *
 * The path is scoped by account id, which is what the storage policies check,
 * so the browser cannot write into another account's folder even though it
 * performs the upload directly.
 */
async function uploadAvatar(file: File, bucket: string) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 5_000_000) throw new Error("Images must be smaller than 5 MB.");
  const supabase = supabaseBrowser();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Sign in before uploading an image");
  const path = avatarObjectPath(userData.user.id, file.name);
  const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

export default function Home() {
  const router=useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ageAccepted, setAgeAccepted] = useState<boolean | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatIndex, setChatIndex] = useState<Conversation[]>([]);
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
  const [storyNavigation, setStoryNavigation] = useState(closedStoryNavigation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("home");
  const [studioStartSection, setStudioStartSection] = useState<"identity" | "definition" | "world">("identity");
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [models, setModels] = useState<string[]>([]);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({ providers: [], models: [], engines: [] });
  const [editing, setEditing] = useState<Character | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [recallMessage, setRecallMessage] = useState<Message | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editWidth, setEditWidth] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [chatNotice, setChatNotice] = useState("");
  const [accountNotice,setAccountNotice]=useState("");
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const [sidebarCharacterMenuId,setSidebarCharacterMenuId]=useState<string|null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const requestedConversationRef = useRef<string | null>(null);
  const pinnedToBottomRef = useRef(true);
  const variantDesiredRef = useRef(new Map<string,{ message:Message; index:number; position:number }>());
  const variantWorkersRef = useRef(new Set<string>());
  const branchPendingRef = useRef<string | null>(null);
  const routeHandledRef=useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const selected = useMemo(() => characters.find((item) => item.id === selectedId) ?? null, [characters, selectedId]);
  const activePersona = useMemo(() => personas.find((item) => item.id === conversation?.personaId) ?? personas.find((item) => item.isDefault) ?? null, [personas, conversation?.personaId]);
  const ownedCharacters=useMemo(()=>characters.filter((character)=>character.ownedByViewer),[characters]);
  const closeStoryNavigation=()=>setStoryNavigation((state)=>closeStorySurface(state));
  const openComposerTool=(child:StoryChild)=>{setStoryNavigation(openChatChild(child));setComposerToolsOpen(false);};
  const openCharacterPage=(characterId:string)=>router.push(`/characters/${characterId}`);

  const loadChat = useCallback(async (characterId: string, conversationId?: string) => {
    const query = new URLSearchParams({ characterId });
    if (conversationId) query.set("conversationId", conversationId);
    const data = await api<{ conversations: Conversation[]; conversation: Conversation; messages: Message[] }>(`/api/conversations?${query}`);
    setConversations(data.conversations); setConversation(data.conversation); setMessages(data.messages);
    if (isAdmin) {
      const memoryData = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(characterId,data.conversation.id));
      setMemories(memoryData.memories); setMemoryArcs(memoryData.arcs);
    } else { setMemories([]); setMemoryArcs([]); }
    return data;
  }, [isAdmin]);

  const loadCharacters = useCallback(async () => {
    try {
      const [owned,chats] = await Promise.all([api<{ characters: Character[] }>("/api/characters"),api<{characters:Character[]}>("/api/characters?scope=chats")]);
      // A chat snapshot deliberately has no reusable world links. Prefer the
      // live owned card when both exist, otherwise editing a character reached
      // from Chats appears to have zero worlds and saving it detaches them.
      const ownedById = new Map(owned.characters.map((character) => [character.id, character]));
      const merged=[...chats.characters.map((character)=>ownedById.get(character.id) ?? character),...owned.characters.filter((character)=>!chats.characters.some((chat)=>chat.id===character.id))];
      setCharacters(merged);
      setSelectedId((current) => current && merged.some((item) => item.id === current) ? current : merged[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load characters"); }
  }, []);
  const loadChatIndex = useCallback(async () => {
    const data = await api<{ conversations: Conversation[] }>("/api/conversations?scope=all");
    setChatIndex(data.conversations);
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
    if (!supabaseBrowserConfigured()) { setAuthenticated(false); return; }
    const loadSession = () => api<{ authenticated: boolean; profile: Profile | null; isAdmin?: boolean }>("/api/session")
      .then((data) => { setAuthenticated(data.authenticated); setProfile(data.profile); setIsAdmin(Boolean(data.isAdmin)); })
      .catch(() => { setAuthenticated(false); setProfile(null); setIsAdmin(false); });
    void loadSession();
    // Sign-in and sign-out happen in the browser client, so mirror its state.
    const { data: listener } = supabaseBrowser().auth.onAuthStateChange(() => { void loadSession(); });
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (authenticated) { void loadCharacters(); void loadChatIndex().catch(() => undefined); void loadLibraries().catch(() => undefined); api<{ settings: AppSettings; models: string[]; catalog: ModelCatalog }>("/api/settings").then((data) => { setSettings({...defaultSettings,...data.settings}); setModels(data.models ?? []); setModelCatalog(data.catalog ?? {providers:[],models:[],engines:[]}); }).catch(() => undefined); } }, [authenticated, loadCharacters, loadChatIndex, loadLibraries]);
  useEffect(()=>{if(!authenticated)return;if(new URLSearchParams(window.location.search).get("verification")==="success"){setAccountNotice("Email verified — welcome to Afterglow.");const timeout=window.setTimeout(()=>setAccountNotice(""),5000);return()=>window.clearTimeout(timeout);}},[authenticated]);
  useEffect(()=>{
    if(!authenticated||routeHandledRef.current)return;
    const params=new URLSearchParams(window.location.search);
    const view=params.get("view") as AppView|null;
    if(view&&["home","chats","worlds","personas","profile","likes"].includes(view)){setActiveView(view);routeHandledRef.current=true;return;}
    if(params.get("create")==="1"){setEditing(null);setStudioStartSection("identity");setStudioOpen(true);routeHandledRef.current=true;return;}
    const characterId=params.get("editCharacter")||params.get("character");
    if(!characterId)return;
    routeHandledRef.current=true;
    void api<{character:Character}>(`/api/characters/${characterId}`).then(({character})=>{
      setCharacters((items)=>items.some((item)=>item.id===character.id)?items:[character,...items]);
      setSelectedId(character.id);
      if(params.get("editCharacter")){
        if(character.ownedByViewer){setEditing(character);setStudioStartSection("identity");setStudioOpen(true);}
        else {router.replace(`/characters/${character.id}`);return;}
      }else{
        requestedConversationRef.current=params.get("conversation");
        setActiveView("chat");
      }
      window.history.replaceState({},"","/");
    }).catch((reason)=>setError(reason instanceof Error?reason.message:"Could not open character"));
  },[authenticated,router]);
  useEffect(() => {
    if (!selectedId || !authenticated) { setConversation(null); setConversations([]); setMessages([]); setMemories([]); setMemoryArcs([]); return; }
    if (activeView !== "chat") return;
    setError("");
    const requestedConversationId = requestedConversationRef.current;
    requestedConversationRef.current = null;
    loadChat(selectedId, requestedConversationId ?? undefined).catch((e) => setError(e instanceof Error ? e.message : "Could not open conversation"));
  }, [selectedId, authenticated, activeView, loadChat]);
  const scrollToBottom = useCallback(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    pinnedToBottomRef.current = true; setAtBottom(true);
  }, []);
  // The message list unmounts with the chat view, so snap to the newest message as it mounts.
  const attachMessageList = useCallback((node: HTMLDivElement | null) => {
    messagesRef.current = node;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    pinnedToBottomRef.current = true; setAtBottom(true);
  }, []);
  const trackScrollPosition = useCallback(() => {
    const node = messagesRef.current;
    if (!node) return;
    const pinned = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    pinnedToBottomRef.current = pinned; setAtBottom(pinned);
  }, []);
  // Open every chat at the newest message instead of at the top of the history.
  useEffect(() => { scrollToBottom(); }, [conversation?.id, scrollToBottom]);
  // Follow new content only while the reader is already at the bottom, and never animate it.
  useEffect(() => { if (pinnedToBottomRef.current) scrollToBottom(); }, [messages, scrollToBottom]);
  // Message controls appear only after streaming finishes and increase the
  // final row's height. Re-pin after that layout settles so iPhone does not
  // appear to jump upward above the completed reply.
  useEffect(() => {
    if (streaming || !pinnedToBottomRef.current) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    return () => cancelAnimationFrame(frame);
  }, [streaming, scrollToBottom]);
  // Grow the composer with its content instead of keeping one fixed row.
  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [composer, selectedId]);
  useEffect(() => {
    if (!chatNotice) return;
    const timeout = window.setTimeout(() => setChatNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [chatNotice]);
  // Keep the inline message editor exactly as tall as the message it holds.
  useEffect(() => {
    const node = editorRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [editDraft, editingMessageId]);

  async function send(action: "send" | "regenerate" | "continue" = "send", regenerationTargetOverride?: string | null) {
    if (!conversation || streaming || (action === "send" && !composer.trim())) return;
    setError(""); setStreaming(true);
    scrollToBottom();
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
      if (completed) {
        // The streamed placeholder is already the canonical persisted message:
        // the server returns its final id, variants and recall references in
        // the done event. Re-fetching the whole transcript here used to keep
        // controls hidden behind network/database work and then replace every
        // message object, producing the visible completion blink.
        const added = action === "send" ? 2 : action === "continue" ? 1 : 0;
        const updatedAt = new Date().toISOString();
        setConversation((current) => current ? { ...current, messageCount: current.messageCount + added, updatedAt } : current);
        setConversations((items) => items.map((item) => item.id === conversation.id ? { ...item, messageCount:item.messageCount + added, updatedAt } : item));
        void loadChatIndex().catch(() => undefined);
      }
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
      setConversation(data.conversation); setMessages(data.messages); setConversations((items) => [data.conversation, ...items]); setStoryNavigation(closedStoryNavigation);
      setChatIndex((items) => [data.conversation, ...items]); setActiveView("chat");
      if (isAdmin) { const memoryData = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(selected.id,data.conversation.id)); setMemories(memoryData.memories); setMemoryArcs(memoryData.arcs); }
      else { setMemories([]); setMemoryArcs([]); }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start a new chat"); }
  }

  async function updateConversationContext(changes: Partial<Pick<Conversation,"personaId" | "providerId" | "modelId" | "rpEngineId" | "instructionPresets" | "customInstructions" | "responseLength" | "temperature">>) {
    if (!conversation) return;
    try {
      const data = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      setConversation(data.conversation); setConversations((items) => items.map((item) => item.id === data.conversation.id ? data.conversation : item));
      setChatIndex((items) => items.map((item) => item.id === data.conversation.id ? data.conversation : item));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this chat"); }
  }

  function beginEdit(message: Message, bubble?: Element | null) {
    if (streaming) return;
    // Open the editor at the rendered size of the message it replaces, with
    // just enough room left for the Cancel/Save row on very short messages.
    const width = bubble instanceof HTMLElement ? Math.round(bubble.getBoundingClientRect().width) : 0;
    const room = messagesRef.current?.clientWidth ?? 0;
    setEditWidth(width > 0 ? Math.max(width, Math.min(320, room || width)) : null);
    setEditingMessageId(message.id); setEditDraft(message.content);
  }

  async function saveMessageEdit(message: Message, messagePosition: number) {
    const content = editDraft.trim();
    if (!content) return;
    if (content === message.content) { setEditingMessageId(null); return; }
    try {
      const data = await api<{ message: Message }>(`/api/messages/${message.id}`, { method: "PATCH", body: JSON.stringify({ messageId: message.id, content, truncateAfter: false, conversationId: message.conversationId, messagePosition }) });
      setMessages((items) => items.map((item) => item.id === message.id ? data.message : item));
      setEditingMessageId(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not edit message"); }
  }

  function selectVariant(message: Message, index: number, messagePosition: number) {
    if (streaming || index === message.selectedVariant || index < 0 || index >= message.variants.length) return;
    variantDesiredRef.current.set(message.id,{message,index,position:messagePosition});
    setMessages((items) => items.map((item) => item.id === message.id ? { ...item, selectedVariant:index, content:item.variants[index] } : item));
    if (variantWorkersRef.current.has(message.id)) return;
    variantWorkersRef.current.add(message.id);
    void (async () => {
      // Coalesce quick taps, then serialize every remaining save. This keeps
      // the UI instant while guaranteeing that a late network response cannot
      // replay an older option over the user's final choice.
      await new Promise((resolve)=>window.setTimeout(resolve,140));
      let reloadAfterSave=false;
      try {
        while (true) {
          const desired=variantDesiredRef.current.get(message.id);
          if (!desired) break;
          try {
            const data=await api<{message:Message}>(`/api/messages/${message.id}`,{method:"PATCH",body:JSON.stringify({messageId:message.id,variantIndex:desired.index,conversationId:desired.message.conversationId,messagePosition:desired.position})});
            const latest=variantDesiredRef.current.get(message.id);
            if (!latest || latest.index !== desired.index) continue;
            variantDesiredRef.current.delete(message.id);
            setMessages((items)=>items.map((item)=>item.id===message.id&&item.selectedVariant===desired.index?data.message:item));
            reloadAfterSave=desired.position<messages.length;
          } catch (e) {
            const latest=variantDesiredRef.current.get(message.id);
            if (latest && latest.index !== desired.index) continue;
            variantDesiredRef.current.delete(message.id);
            if (conversation) await loadChat(conversation.characterId,conversation.id).catch(()=>undefined);
            setError(e instanceof Error?e.message:"Could not select that version");
            break;
          }
        }
        if (reloadAfterSave&&conversation) await loadChat(conversation.characterId,conversation.id);
      } finally { variantWorkersRef.current.delete(message.id); }
    })();
  }

  async function branchFromMessage(message:Message) {
    if (!conversation||streaming||branchPendingRef.current) return;
    branchPendingRef.current=message.id; setBranchPendingMessageId(message.id); setError(""); setChatNotice("");
    const branchRequestId=crypto.randomUUID();
    try {
      const data=await api<{conversation:Conversation;messages:Message[]}>("/api/conversations",{method:"POST",body:JSON.stringify({branchFromConversationId:conversation.id,branchFromMessageId:message.id,branchRequestId})});
      setConversation(data.conversation); setMessages(data.messages); setConversations((items)=>[data.conversation,...items]); setChatIndex((items)=>[data.conversation,...items]);
      if (isAdmin) { const memoryData=await api<{memories:Memory[];arcs:MemoryArc[]}>(memoriesUrl(data.conversation.characterId,data.conversation.id)); setMemories(memoryData.memories); setMemoryArcs(memoryData.arcs); }
      else { setMemories([]); setMemoryArcs([]); }
      setChatNotice("Branch created"); scrollToBottom();
    } catch(e) { setError(e instanceof Error?e.message:"Could not create a parallel story"); }
    finally { branchPendingRef.current=null; setBranchPendingMessageId(null); }
  }

  async function deleteFromMessage(message: Message, messagePosition: number) {
    if (!conversation || streaming || !window.confirm("Delete this message and everything after it?")) return;
    try {
      await api(`/api/messages/${message.id}`, { method: "DELETE", body: JSON.stringify({ messageId: message.id, conversationId: message.conversationId, messagePosition }) });
      await loadChat(conversation.characterId, conversation.id);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete message"); }
  }

  if (ageAccepted === null || authenticated === null) return <div className="splash"><Logo /><div className="pulse" /></div>;
  if (!ageAccepted) return <AgeGate onAccept={() => { localStorage.setItem("afterglow_age_verified", "yes"); setAgeAccepted(true); }} />;
  if (!supabaseBrowserConfigured()) return <ConfigNotice />;
  if (!authenticated) return <AuthGate />;

  return (
    <main className="app-shell">
      {accountNotice&&<div className="account-notice" role="status"><span>✦</span>{accountNotice}<button onClick={()=>setAccountNotice("")}>×</button></div>}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand"><Logo /><button className="icon-button mobile-only" aria-label="Close menu" onClick={() => setSidebarOpen(false)}>×</button></div>
        <nav className="primary-nav">
          <button className={activeView === "home" ? "active" : ""} onClick={() => { setActiveView("home"); setSidebarOpen(false); }}><span>⌂</span><strong>Home</strong></button>
          <button className={activeView === "chats" || activeView === "chat" ? "active" : ""} onClick={() => { setActiveView("chats"); setSidebarOpen(false); }}><span>◫</span><strong>Chats</strong></button>
          <button onClick={() => { setStudioStartSection("identity"); setEditing(null); setStudioOpen(true); setSidebarOpen(false); }}><span>＋</span><strong>Create</strong></button>
          <button className={activeView === "worlds" ? "active" : ""} onClick={() => { setActiveView("worlds"); setSidebarOpen(false); }}><span>▤</span><strong>World</strong></button>
          <button className={activeView === "profile" ? "active" : ""} onClick={() => { setActiveView("profile"); setSidebarOpen(false); }}><span>◉</span><strong>Profile</strong></button>
          <button className={activeView === "personas" ? "active" : ""} onClick={() => { setActiveView("personas"); setSidebarOpen(false); }}><span>◎</span><strong>Personas</strong></button>
          <button className={activeView === "likes" ? "active" : ""} onClick={() => { setActiveView("likes"); setSidebarOpen(false); }}><span>♡</span><strong>Likes</strong></button>
          <button onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}><span>≛</span><strong>Settings</strong></button>
        </nav>
        <section className="sidebar-characters" aria-label="Your Characters"><span className="sidebar-section-title">Your Characters</span>{ownedCharacters.map((character)=><div className="sidebar-character" key={character.id}><button className="sidebar-character-link" title={`View ${character.name}`} onClick={()=>openCharacterPage(character.id)}><Avatar character={character}/><strong>{character.name}</strong></button><button className="sidebar-character-more" aria-label={`View or edit ${character.name}`} aria-expanded={sidebarCharacterMenuId===character.id} onClick={()=>setSidebarCharacterMenuId((current)=>current===character.id?null:character.id)}>•••</button>{sidebarCharacterMenuId===character.id&&<div className="sidebar-character-menu"><button onClick={()=>openCharacterPage(character.id)}>View {character.name}</button><button onClick={()=>{setStudioStartSection("identity");setEditing(character);setStudioOpen(true);setSidebarCharacterMenuId(null);setSidebarOpen(false);}}>Edit {character.name}</button></div>}</div>)}</section>
        <div className="sidebar-footer"><div className="privacy-pill"><span>◆</span><div><strong>{profile?.displayName || activePersona?.name || "Your account"}</strong><small>{activePersona ? `Playing as ${activePersona.name}` : "Private library"}</small></div></div><div className="sidebar-links"><button className="sidebar-lock" aria-label="Sign out" title="Sign out" onClick={async () => { await supabaseBrowser().auth.signOut(); setSidebarOpen(false); setAuthenticated(false); setProfile(null); }}><span>⇥</span><strong>Sign out</strong></button></div></div>
      </aside>
      {activeView !== "chat" && <button className="global-mobile-menu" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>☰</button>}

      {activeView === "home" ? <HomeFeed onOpen={(character) => openCharacterPage(character.id)} /> : activeView === "chats" ? <ChatLibrary characters={characters} conversations={chatIndex} personas={personas} onOpen={(characterId,conversationId) => { requestedConversationRef.current = conversationId ?? null; setSelectedId(characterId); setActiveView("chat"); }} /> : activeView === "worlds" ? <WorldLibrary worlds={worlds} onChange={() => void loadLibraries()} /> : activeView === "personas" ? <PersonaLibrary personas={personas} onClose={() => setActiveView(conversation ? "chat" : "chats")} onChange={() => void loadLibraries()} /> : activeView === "profile" ? <AccountProfile profile={profile} onSaved={setProfile} /> : activeView === "likes" ? <LikedCharacters onOpen={(character)=>openCharacterPage(character.id)} /> : selected ? (
        <section className="chat-panel">
          <header className="chat-header">
            <div className="chat-identity"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu">☰</button><button className="identity-profile" title={`View ${selected.name}`} onClick={() => openCharacterPage(selected.id)}><Avatar character={selected} large /><span><span className="eyebrow conversation-preview" title={conversation?.title}>{compactMessagePreview(conversation?.title || "Private conversation")}</span><strong>{selected.name}</strong><small>{selected.profileType === "ensemble" ? "Multiple characters" : `Chatting as ${activePersona?.name || "You"}`}</small></span></button></div>
            <div className="header-actions">
              <button className="icon-button labeled" onClick={() => setStoryNavigation(openStory())}><span>⌘</span><span>Story</span></button>
              {isAdmin && <button className="icon-button labeled" onClick={() => setMemoryOpen(true)}><span>⌁</span><span>Memories</span>{memories.length > 0 && <b>{memories.length}</b>}</button>}
              {selected.ownedByViewer?<button className="icon-button labeled" title={`Edit ${selected.name}`} onClick={() => { setStudioStartSection("identity"); setEditing(selected); setStudioOpen(true); }}><span>✎</span><span>Edit</span></button>:<button className="icon-button labeled" title={`View ${selected.name}`} onClick={()=>openCharacterPage(selected.id)}><span>◉</span><span>Page</span></button>}
            </div>
          </header>
          <div className="messages" ref={attachMessageList} onScroll={trackScrollPosition}>
            <div className="date-divider"><span>THE STORY SO FAR</span></div>
            {messages.map((message, index) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" && <Avatar character={selected} />}
                <div className="message-stack">
                  <div className="message-meta"><strong>{message.role === "assistant" ? selected.name : activePersona?.name || "You"}</strong><time>{time(message.createdAt)}</time></div>
                  <div className={`bubble ${!message.content && streaming ? "typing" : ""} ${editingMessageId === message.id ? "editing" : ""}`} style={editingMessageId === message.id && editWidth ? { width: editWidth } : undefined}>
                    {editingMessageId === message.id ? <div className="inline-editor"><textarea ref={editorRef} rows={1} autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditingMessageId(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMessageEdit(message,index + 1); } }} /><div><span>Esc to cancel · ⌘/Ctrl + Enter to save</span><button onClick={() => setEditingMessageId(null)}>Cancel</button><button className="save-edit" disabled={!editDraft.trim()} onClick={() => void saveMessageEdit(message,index + 1)}>Save</button></div></div> : <>{message.content ? (message.role === "assistant" ? tokenizeCharacterMessage(message.content).map((segment, segmentIndex) => <span className={`message-segment ${segment.kind}`} key={segmentIndex}>{segment.text}</span>) : message.content) : <><i /><i /><i /></>}{message.role === "assistant" && message.content && message.variants.length > 1 && <div className="variant-picker"><button aria-label="Previous response option" disabled={streaming || message.selectedVariant === 0} onClick={() => void selectVariant(message,message.selectedVariant - 1,index + 1)}>‹</button><span>Option <strong>{message.selectedVariant + 1}</strong> of {message.variants.length}</span><button aria-label="Next response option" disabled={streaming || message.selectedVariant === message.variants.length - 1} onClick={() => void selectVariant(message,message.selectedVariant + 1,index + 1)}>›</button><em>Selected</em></div>}</>}
                  </div>
                  {message.content && !streaming && editingMessageId !== message.id && <div className="message-actions"><button onClick={(e) => beginEdit(message, e.currentTarget.closest(".message-stack")?.querySelector(".bubble"))}>✎ Edit</button><button onClick={() => void deleteFromMessage(message,index + 1)}>⌫ Delete from here</button>{message.role === "assistant" && <><button disabled={Boolean(branchPendingMessageId)} title="Create a separate story containing everything through this reply" onClick={() => void branchFromMessage(message)}>{branchPendingMessageId===message.id?"◌ Creating…":"⑂ Branch here"}</button>{isAdmin && <button title="See which durable memories and historical arcs were recalled for this reply" onClick={() => setRecallMessage(message)}>⌁ {message.memoryIds.length + message.arcIds.length ? `${message.memoryIds.length + message.arcIds.length} recalled` : "Context"}</button>}</>}{message.role === "assistant" && index === messages.length - 1 && <><button onClick={() => void send("regenerate")}>↻ Regenerate</button><button className="continue-action" title="Generate the character's next message" onClick={() => void send("continue")}>▶ Continue</button></>}</div>}
                </div>
              </article>
            ))}
          </div>
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
          {chatNotice && <div className="success-banner" role="status"><span>✓</span><strong>{chatNotice}</strong><button onClick={() => setChatNotice("")}>×</button></div>}
          <div className="composer-wrap">
            {!atBottom && <button className="jump-latest" aria-label="Jump to the latest message" onClick={scrollToBottom}>↓ Latest</button>}
            <div className="mode-strip"><span className={selected.nsfwEnabled ? "adult-on" : ""}>{selected.nsfwEnabled ? "18+ adult mode" : "SFW mode"}</span><span>•</span><span>{activePersona?.name || "You"}</span>{conversation && (conversation.instructionPresets.length > 0 || conversation.customInstructions) && <><span>•</span><span>{conversation.instructionPresets.length + (conversation.customInstructions ? 1 : 0)} instructions</span></>}</div>
            {composerToolsOpen && <div className="composer-tools">
              {selected.ownedByViewer&&<button onClick={() => openComposerTool("world")}><span>▤</span><strong>World</strong><small>{selected.worldIds.length} attached</small></button>}
              <button onClick={() => openComposerTool("persona")}><span>◉</span><strong>Persona</strong><small>{activePersona?.name || "Choose who you are"}</small></button>
              <button onClick={() => openComposerTool("instructions")}><span>⌘</span><strong>Instructions</strong><small>{conversation?.instructionPresets.length || 0} selected</small></button>
              <button onClick={() => openComposerTool("model")}><span>✦</span><strong>Model</strong><small>{modelCatalog.engines.find((engine)=>engine.id===(conversation?.rpEngineId||settings.roleplayPreset))?.label || "Choose RP model"}</small></button>
            </div>}
            <div className="composer">
              <button className={`composer-plus ${composerToolsOpen ? "active" : ""}`} aria-label="Chat tools" onClick={() => setComposerToolsOpen((value) => !value)}>{composerToolsOpen ? "×" : "+"}</button>
              <textarea ref={composerRef} value={composer} onChange={(e) => setComposer(e.target.value)} placeholder={`Message ${selected.name}…`} rows={1} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !window.matchMedia("(max-width: 760px)").matches) { e.preventDefault(); void send(); } }} disabled={streaming} />
              <button className="send-button" aria-label="Send message" disabled={streaming || !composer.trim()} onClick={() => void send()}>↑</button>
            </div>
            <small className="composer-hint"><span className="desktop-composer-hint">Enter to send · Shift + Enter for a new line</span><span className="mobile-composer-hint">Enter for a new line · Tap ↑ to send</span></small>
          </div>
        </section>
      ) : (
        <section className="empty-state"><div className="orb">✦</div><span className="eyebrow">Your private story studio</span><h1>Create someone<br />worth remembering.</h1><p>Shape their history, voice, desires, and boundaries. Afterglow keeps the moments that matter.</p><button className="primary" onClick={() => setStudioOpen(true)}>Create your first character</button></section>
      )}

      {studioOpen && <CharacterStudio character={editing} worlds={worlds} startSection={studioStartSection} onOpenWorldLibrary={() => { setStudioOpen(false); setEditing(null); setActiveView("worlds"); }} onLibrariesChanged={() => void loadLibraries()} onClose={() => { setStudioOpen(false); setEditing(null); }} onSaved={async (character) => { setStudioOpen(false); setEditing(null); await Promise.all([loadCharacters(),loadLibraries(),loadChatIndex()]); setSelectedId(character.id); setActiveView("chat"); }} onDeleted={async () => { setStudioOpen(false); setEditing(null); await Promise.all([loadCharacters(),loadChatIndex()]); setActiveView("chats"); }} />}
      {isAdmin && memoryOpen && selected && <MemoryDrawer character={selected} conversation={conversation} memories={memories} onClose={() => setMemoryOpen(false)} onChange={async () => { const data = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(selected.id,conversation?.id)); setMemories(data.memories); setMemoryArcs(data.arcs); }} />}
      {storyNavigation.surface==="story" && selected && <ConversationDrawer character={selected} conversation={conversation} settings={settings} catalog={modelCatalog} personas={personas} conversations={conversations} activeId={conversation?.id ?? null} onClose={() => setStoryNavigation(closedStoryNavigation)} onNew={(greetingIndex,personaId) => void newConversation(greetingIndex,personaId)} onSelect={async (id) => { await loadChat(selected.id,id); setStoryNavigation(closedStoryNavigation); }} onChange={() => void loadChat(selected.id)} onUpdate={updateConversationContext} onOpenModel={()=>setStoryNavigation(openStoryChild("model"))} onOpenPersona={()=>setStoryNavigation(openStoryChild("persona"))} onOpenInstructions={()=>setStoryNavigation(openStoryChild("instructions"))} onOpenWorld={()=>setStoryNavigation(openStoryChild("world"))} />}
      {settingsOpen && <SettingsDrawer isAdmin={isAdmin} settings={settings} models={models} catalog={modelCatalog} onClose={() => setSettingsOpen(false)} onSaved={(value) => { setSettings({...defaultSettings,...value}); setSettingsOpen(false); }} onImported={async () => { await loadCharacters(); const data = await api<{ settings: AppSettings; catalog: ModelCatalog }>("/api/settings"); setSettings({...defaultSettings,...data.settings}); if(data.catalog)setModelCatalog(data.catalog); }} />}
      {isAdmin && recallMessage && <RecallDrawer message={recallMessage} memories={memories} arcs={memoryArcs} onClose={() => setRecallMessage(null)} />}
      {storyNavigation.surface==="instructions" && conversation && <InstructionsDrawer conversation={conversation} onClose={closeStoryNavigation} onSave={async (changes) => { await updateConversationContext(changes); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="persona" && conversation && <PersonaPicker personas={personas} selectedId={conversation.personaId || activePersona?.id || null} onClose={closeStoryNavigation} onManage={() => { setStoryNavigation(closedStoryNavigation); setActiveView("personas"); }} onCreated={(persona)=>setPersonas((items)=>[persona,...items])} onSave={async (personaId) => { await updateConversationContext({personaId}); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="model" && conversation && <ModelPicker catalog={modelCatalog} conversation={conversation} onClose={closeStoryNavigation} onSave={async (changes) => { await updateConversationContext(changes); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="world" && selected?.ownedByViewer && <WorldPicker character={selected} worlds={worlds} onClose={closeStoryNavigation} onCreated={(world)=>setWorlds((items)=>[world,...items])} onSaved={(character)=>{setCharacters((items)=>items.map((item)=>item.id===character.id?character:item));closeStoryNavigation();}} />}
    </main>
  );
}

function Logo() { return <div className="logo"><span className="logo-mark">A</span><span>Afterglow</span></div>; }

function Avatar({ character, large = false }: { character: Character; large?: boolean }) {
  const source = avatarSource(characterAvatarBucket, character.avatarPath, character.avatarUrl);
  return <div className={`avatar ${large ? "large" : ""}`} style={{ "--accent": character.accent } as React.CSSProperties}>{source ? <img src={source} alt="" /> : <span>{initials(character.name)}</span>}</div>;
}

/**
 * Shown when the browser bundle was built without the Supabase settings.
 *
 * This is a build-time misconfiguration rather than a runtime one, so it is
 * worth naming precisely: the server can be perfectly configured while the
 * browser has nothing, and the symptom is otherwise a blank page.
 */
function ConfigNotice() {
  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol">◇</div>
    <span className="eyebrow">Configuration needed</span>
    <h1>Almost there.</h1>
    <p>This build has no Supabase settings baked into it, so sign-in cannot load.</p>
    <p className="config-hint"><code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> are read while the app is built, not when it starts. Set them on the service and <strong>redeploy</strong> — adding them without rebuilding will not fix this.</p>
  </div></main>;
}

/**
 * Email/password sign-in and sign-up backed by Supabase Auth.
 *
 * The browser only ever holds the publishable anon key; the session cookies it
 * sets are what the server revalidates on every request.
 */
function AuthGate() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(()=>{const status=new URLSearchParams(window.location.search).get("verification");if(status==="invalid")setError("That verification link is invalid or has expired. Request a fresh email below.");if(status==="success")setNotice("Email verified. You can sign in now.");},[]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const supabase = supabaseBrowser();
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email, password, options: { emailRedirectTo:`${window.location.origin}/auth/callback?next=/`,data: { display_name: displayName.trim() || email.split("@")[0] } },
        });
        if (signUpError) throw signUpError;
        // Projects with email confirmation enabled return no session yet.
        if (!data.session) setNotice("We sent a verification link. Open it on this device to finish creating your Afterglow account.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally { setBusy(false); }
  }
  async function resend(){if(!email){setError("Enter your email address first.");return;}setBusy(true);setError("");try{const {error:resendError}=await supabaseBrowser().auth.resend({type:"signup",email,options:{emailRedirectTo:`${window.location.origin}/auth/callback?next=/`}});if(resendError)throw resendError;setNotice("A fresh verification link is on its way.");}catch(reason){setError(reason instanceof Error?reason.message:"Could not resend verification");}finally{setBusy(false);}}

  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol">◇</div>
    <span className="eyebrow">{mode === "signup" ? "Create an account" : "Welcome back"}</span>
    <h1>{mode === "signup" ? "Begin your story." : "Sign in."}</h1>
    <p>{mode === "signup" ? "Your characters, chats, and memories stay private to your account." : "Your library is waiting exactly where you left it."}</p>
    <form onSubmit={submit}>
      {mode === "signup" && <input autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />}
      <input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
      <input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      <button className="primary" disabled={busy || !email || password.length < 8}>{busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}</button>
      {error && <small className="form-error">{error}</small>}
      {notice && <div className="verification-notice"><span>✦</span><p>{notice}</p><button type="button" disabled={busy} onClick={()=>void resend()}>Resend email</button></div>}
    </form>
    <button className="text-button auth-switch" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}>
      {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
    </button>
  </div></main>;
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
      setForm(characterDraft({ ...data.character, id: "draft", ownedByViewer: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
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
      const payload = characterDraft({ ...form, lorebook: "", worldIds, id: character?.id || "draft", ownedByViewer: true, createdAt: character?.createdAt || new Date().toISOString(), updatedAt: character?.updatedAt || new Date().toISOString() });
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
    {!character && <div className="generator"><div className="generator-tabs"><button className={generatorMode === "idea" ? "active" : ""} onClick={() => setGeneratorMode("idea")}>Quick idea</button><button className={generatorMode === "dump" ? "active" : ""} onClick={() => setGeneratorMode("dump")}>Paste everything</button></div><div><label>{generatorMode === "dump" ? "Dump all your character material" : "Start with an idea"}<small>{generatorMode === "dump" ? "Paste up to 100,000 characters. Afterglow detects multiple-character cards, separates reusable world material, creates opening options, and keeps the untouched source for review." : "Describe one character or a complete cast/story concept."}</small></label><textarea maxLength={100000} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder={generatorMode === "dump" ? "Paste the complete card, descriptions, dialogue, scenarios, lorebooks, rules, and notes here…" : "A sharp-witted art thief in her thirties who meets me at a rain-soaked Paris café…"} rows={generatorMode === "dump" ? 12 : 3} /></div><div className="generator-row"><ChoiceField label="Tone" value={tone} onChange={setTone} options={[{value:"dramatic",label:"Dramatic"},{value:"romantic",label:"Romantic"},{value:"playful",label:"Playful"},{value:"adventurous",label:"Adventurous"},{value:"comforting",label:"Comforting"},{value:"custom",label:"Preserve supplied tone"}]} compact/><span className="character-count">{idea.length.toLocaleString()} / 100,000</span><button className="magic-button" disabled={busy || idea.trim().length < 8} onClick={() => void generate()}>✦ {busy ? (generatorMode === "dump" ? "Mapping characters & worlds…" : "Dreaming…") : (generatorMode === "dump" ? "Import and organize" : "Generate profile")}</button></div></div>}
    <div className="character-card-preview"><Avatar character={{ ...form, id: "preview", ownedByViewer: true, createdAt: "", updatedAt: "" }} large /><div><span className="eyebrow">{form.profileType === "ensemble" ? "Multiple characters" : "Character card"}</span><strong>{form.name || "Untitled character"}</strong><p>{form.profileType === "ensemble" ? `${form.cast.length} recurring characters` : "Single-character roleplay"}</p><div><span>{form.cast.length} cast</span><span>{openings.filter(Boolean).length} openings</span><span>{form.worldIds.length + (form.lorebook.trim() ? 1 : 0)} worlds</span></div></div></div>
    {generated && <div className="import-summary"><strong>Import mapped without discarding the source.</strong><span>{form.profileType === "ensemble" ? "Multiple characters detected" : "Single character detected"} · {form.cast.length} cast entries · {openings.filter(Boolean).length} openings · {form.sourceMaterial.length.toLocaleString()} source characters retained</span></div>}
    <nav className="studio-sections"><button className={section === "identity" ? "active" : ""} onClick={() => setSection("identity")}>General</button><button className={section === "definition" ? "active" : ""} onClick={() => setSection("definition")}>Definition</button><button className={section === "world" ? "active" : ""} onClick={() => setSection("world")}>World & openings</button></nav>
    <div className="form-grid">
      {character && <div className="profile-note wide"><span>Complete saved profile</span><p>Saving updates future replies without deleting existing chats or memories. Imported source is retained separately from the chat prompt.</p></div>}
      {section === "identity" && <>
        <ChoiceField label="Card type" value={form.profileType} onChange={(value)=>field("profileType",value as CharacterDraft["profileType"])} options={[{value:"single",label:"Single character"},{value:"ensemble",label:"Multiple characters"}]}/><label>Accent<input className="color-input" type="color" value={form.accent} onChange={(e) => field("accent", e.target.value)} /></label>
        <label className="wide">Character name<input value={form.name} onChange={(e) => field("name", e.target.value)} placeholder={form.profileType === "ensemble" ? "The Wayfarers · Tower of Babel" : "Character name"} /></label>
        <label className="wide">Tagline<input value={form.tagline} maxLength={300} onChange={(e)=>field("tagline",e.target.value)} placeholder="A short line visitors see beneath the name"/></label>
        <div className="avatar-source wide"><div><strong>Character image</strong><small>Upload from your media library or use a direct image link.</small></div><div className="avatar-source-actions"><label className="secondary file-button">↑ Choose image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async (e) => { const file=e.target.files?.[0]; if(!file) return; try { field("avatarPath",await uploadAvatar(file,characterAvatarBucket)); } catch(err) { setError(err instanceof Error ? err.message : "Image upload failed"); } finally { e.target.value=""; } }} /></label>{(form.avatarPath || form.avatarUrl) && <button className="secondary" onClick={() => { field("avatarPath",""); field("avatarUrl",""); }}>Remove</button>}</div><input aria-label="Character image URL" value={form.avatarUrl.startsWith("data:") ? "" : form.avatarUrl} onChange={(e) => field("avatarUrl", e.target.value)} placeholder="https://… (optional)" /></div>
        <label className="toggle-row wide"><span><strong>Adult mode</strong><small>Allows consensual explicit roleplay between fictional adults.</small></span><input type="checkbox" checked={form.nsfwEnabled} onChange={(e) => field("nsfwEnabled", e.target.checked)} /></label>
        <div className="visibility-row wide"><span><strong>Who can see this character</strong><small>Your chats, memories, and story stay private either way. Publishing shares only the character card.</small></span><ChoiceField label="Visibility" value={form.visibility} onChange={(value)=>field("visibility",value as CharacterDraft["visibility"])} options={[{value:"private",label:"Private — only me"},{value:"unlisted",label:"Unlisted — anyone with the link"},{value:"public",label:"Public — listed for others"}]} compact/></div>
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
  const memoryKinds: ChoiceOption[] = [{value:"identity",label:"Identity"},{value:"relationship",label:"Relationship"},{value:"event",label:"Event"},{value:"promise",label:"Promise"},{value:"preference",label:"Preference"},{value:"boundary",label:"Boundary"},{value:"open_loop",label:"Open loop"}];
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer"><header><div><span className="eyebrow">Continuity</span><h2>{character.name}&apos;s memories</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="memory-explainer"><span>⌁</span><p>Generated memories belong only to this chat. Active promises and open loops receive protected recall; resolved ones remain in the permanent archive.</p>{conversation && <button disabled={busy || conversation.messageCount < 2} onClick={async () => { setBusy(true); try { await api("/api/memories/consolidate",{method:"POST",body:JSON.stringify({conversationId:conversation.id})}); onChange(); } finally { setBusy(false); } }}>{busy?"Remembering…":"Refresh now"}</button>}</div>{conversation?.summary && <section className="summary-card"><span className="eyebrow">Rolling story-so-far · this chat</span><p>{conversation.summary}</p></section>}<div className="memory-list">{memories.map((memory) => <article key={memory.id} className={`memory-card memory-${memory.status}`}><div><span className={`memory-pin ${memory.pinned ? "pinned" : ""}`}>{memory.pinned ? "◆ Pinned" : `Importance ${memory.importance}/5`} · {memory.conversationId ? "This chat" : "All chats"} · {memory.status}</span><span className="memory-controls"><ChoiceField label="Memory type" value={memory.kind} options={memoryKinds} onChange={(value)=>void updateMemory(memory,{kind:value as Memory["kind"]})} compact/>{(memory.kind === "promise" || memory.kind === "open_loop") && <ChoiceField label="Memory status" value={memory.status} options={[{value:"active",label:"Active"},{value:"resolved",label:"Resolved"},{value:"superseded",label:"Superseded"}]} onChange={(value)=>void updateMemory(memory,{status:value as Memory["status"],resolution:value === "active" ? "" : memory.resolution})} compact/>}<button onClick={() => void updateMemory(memory,{pinned:!memory.pinned})}>{memory.pinned?"Unpin":"Pin"}</button><button onClick={() => { const value=window.prompt("Edit memory",memory.content)?.trim(); if(value&&value!==memory.content) void updateMemory(memory,{content:value}); }}>Edit</button><button onClick={async () => { if(!window.confirm("Delete this memory?")) return; await api(`/api/memories?id=${memory.id}`, { method: "DELETE" }); onChange(); }}>Delete</button></span></div><p>{memory.content}</p>{memory.resolution && <p className="memory-resolution">Resolved: {memory.resolution}</p>}{memory.keywords.length > 0 && <small>{memory.keywords.map((key) => `#${key}`).join("  ")}</small>}</article>)}</div><form className="memory-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("/api/memories", { method: "POST", body: JSON.stringify({ characterId: character.id, conversationId: scope === "chat" ? conversation?.id ?? null : null, content, kind:"event", keywords: keywords.split(",").map((x) => x.trim()).filter(Boolean), importance: 5, pinned: true }) }); setContent(""); setKeywords(""); onChange(); } finally { setBusy(false); } }}><span className="eyebrow">Add pinned journal</span><ChoiceField label="Use in" value={scope} options={[{value:"chat",label:"This chat only"},{value:"character",label:"All chats with this character"}]} onChange={(value)=>setScope(value as "chat"|"character")}/><textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="A fact, promise, preference, or piece of lore…" rows={3} /><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="Recall keywords, comma separated" /><button className="primary" disabled={busy || !content.trim()}>Add to memory</button></form></aside></div>;
}

function RecallDrawer({ message, memories, arcs, onClose }: { message: Message; memories: Memory[]; arcs: MemoryArc[]; onClose: () => void }) {
  const recalled = message.memoryIds.map((id) => memories.find((memory) => memory.id === id)).filter((memory): memory is Memory => Boolean(memory));
  const recalledArcs = message.arcIds.map((id) => arcs.find((arc) => arc.id === id)).filter((arc): arc is MemoryArc => Boolean(arc));
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer recall-drawer"><header><div><span className="eyebrow">Reply context</span><h2>What this reply remembered</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="memory-explainer"><span>⌁</span><p>Every reply also receives the complete character profile, current rolling summary, and recent transcript. Below are the additional durable memories and historical chapters recalled from the permanent archive.</p></div><div className="memory-list">{recalled.map((memory) => <article className="memory-card" key={memory.id}><div><span className="memory-pin">{memory.kind.replace("_"," ")} · {memory.status} · importance {memory.importance}/5</span></div><p>{memory.content}</p>{memory.resolution && <p className="memory-resolution">Resolution: {memory.resolution}</p>}</article>)}{recalledArcs.map((arc) => <article className="memory-card" key={arc.id}><div><span className="memory-pin">Historical arc · messages {arc.startMessageCount}–{arc.endMessageCount}</span></div><p>{arc.summary}</p></article>)}{!recalled.length && !recalledArcs.length && <section className="summary-card"><span className="eyebrow">No separate archive recall</span><p>Character canon, rolling continuity, and the recent transcript were still included. Older replies created before archive tracing will also show this message.</p></section>}</div></aside></div>;
}

function ConversationDrawer({ character, conversation, settings, catalog, personas, conversations, activeId, onClose, onNew, onSelect, onChange, onUpdate, onOpenModel, onOpenPersona, onOpenInstructions, onOpenWorld }: { character: Character; conversation: Conversation | null; settings: AppSettings; catalog: ModelCatalog; personas: Persona[]; conversations: Conversation[]; activeId: string | null; onClose: () => void; onNew: (greetingIndex: number, personaId: string | null) => void; onSelect: (id: string) => void; onChange: () => void; onUpdate: (changes: Partial<Pick<Conversation,"responseLength"|"temperature">>) => Promise<void>; onOpenModel:()=>void; onOpenPersona:()=>void; onOpenInstructions:()=>void; onOpenWorld:()=>void }) {
  const [personaId,setPersonaId] = useState(personas.find((item) => item.isDefault)?.id ?? personas[0]?.id ?? "");
  const engine=catalog.engines.find((item)=>item.id===(conversation?.rpEngineId||settings.roleplayPreset));
  const activePersona=personas.find((item)=>item.id===conversation?.personaId)??personas.find((item)=>item.isDefault);
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer conversation-drawer"><header><div><span className="eyebrow">Story control center</span><h2>{character.name}</h2></div><button className="icon-button" onClick={onClose}>×</button></header>{conversation&&<section className="story-controls"><div className="story-control-grid"><button onClick={onOpenModel}><span>✦</span><strong>Model</strong><small>{engine?.label||conversation.rpEngineId}</small></button><button onClick={onOpenPersona}><span>◉</span><strong>Persona</strong><small>{activePersona?.name||"Choose who you are"}</small></button><button onClick={onOpenInstructions}><span>⌘</span><strong>Instructions</strong><small>{conversation.instructionPresets.length+(conversation.customInstructions?1:0)} active</small></button><button onClick={onOpenWorld} disabled={!character.ownedByViewer}><span>▤</span><strong>World</strong><small>{character.ownedByViewer?`${character.worldIds.length} attached`:"Creator-owned canon"}</small></button></div><div className="story-preferences"><ChoiceField label="Response length" value={conversation.responseLength||"default"} onChange={(value)=>void onUpdate({responseLength:value==="default"?null:value as Conversation["responseLength"]})} options={[{value:"default",label:`Use default (${settings.responseLength})`},{value:"concise",label:"Concise",description:"Tighter replies with fewer beats."},{value:"natural",label:"Natural",description:"Preserves Afterglow's current pacing."},{value:"detailed",label:"Detailed",description:"Fuller scenes where the moment supports it."}]}/><ChoiceField label="Creativity" value={conversation.temperature==null?"default":String(conversation.temperature)} onChange={(value)=>void onUpdate({temperature:value==="default"?null:Number(value)})} options={[{value:"default",label:`Use default (${settings.temperature})`},{value:"0.7",label:"Grounded"},{value:"0.95",label:"Balanced"},{value:"1.15",label:"Expressive"}]}/></div><p className="setting-note">These choices affect only this story. Messages, branches, and continuity stay intact.</p></section>}<div className="drawer-action"><span className="field-label">Start another story as</span><div className="persona-choice-grid">{personas.map((persona)=><button key={persona.id} className={personaId===persona.id?"selected":""} onClick={()=>setPersonaId(persona.id)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available persona"}</small></span></button>)}</div><button className="primary" onClick={() => onNew(0,personaId || null)}>＋ Start separate story</button><p>Opening messages appear as options on the first reply. Existing stories are never reset.</p></div><div className="conversation-list">{conversations.map((item) => <article key={item.id} className={`conversation-card ${item.id === activeId ? "active" : ""}`}><button className="conversation-main" onClick={() => onSelect(item.id)}><strong>{item.title}</strong><span>{item.messageCount} messages · {personas.find((persona) => persona.id === item.personaId)?.name || "Default persona"} · {new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(new Date(item.updatedAt))}</span></button><div><button title="Rename" onClick={async () => { const title = window.prompt("Conversation title",item.title)?.trim(); if (!title || title === item.title) return; await api(`/api/conversations/${item.id}`,{method:"PATCH",body:JSON.stringify({title})}); onChange(); }}>✎</button><button title="Delete" onClick={async () => { if (!window.confirm(`Delete “${item.title}” and its chat-specific memories? All-chats journal entries will remain.`)) return; await api(`/api/conversations/${item.id}`,{method:"DELETE"}); onChange(); }}>⌫</button></div></article>)}</div></aside></div>;
}

function ChatLibrary({ characters, conversations, personas, onOpen }: { characters: Character[]; conversations: Conversation[]; personas: Persona[]; onOpen: (characterId: string, conversationId?: string) => void }) {
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const toggle=(id:string)=>setExpanded((current)=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Characters and stories</span><h1>Chats</h1><p>Choose a character or expand one to resume a specific story.</p></div></header><div className="chat-library-list">{characters.map((character)=>{const stories=conversations.filter((item)=>item.characterId===character.id);const open=expanded.has(character.id);return <article className={`chat-library-card ${open?"expanded":""}`} key={character.id}><button className="chat-character-main" onClick={()=>onOpen(character.id,stories[0]?.id)}><Avatar character={character} large/><span><strong>{character.name}</strong><small>{character.profileType==="ensemble"?"Multiple characters":"Character"} · {stories.length} {stories.length===1?"story":"stories"}</small></span></button><button className="chat-expand" aria-label={`${open?"Collapse":"Expand"} ${character.name} stories`} aria-expanded={open} onClick={()=>toggle(character.id)}>{open?"⌃":"⌄"}</button><div className="chat-story-list" aria-hidden={!open}>{stories.length?stories.map((story)=><button key={story.id} onClick={()=>onOpen(character.id,story.id)}><span><strong>{story.title}</strong><small>{story.messageCount} messages · {personas.find((persona)=>persona.id===story.personaId)?.name||"Default persona"}</small></span><time>{new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(new Date(story.updatedAt))}</time></button>):<button className="start-first-story" onClick={()=>onOpen(character.id)}>Start first story <span>→</span></button>}</div></article>;})}{!characters.length&&<div className="empty-library-note">No characters or chats yet. Create or import a character to begin.</div>}</div></section>;
}

function HomeFeed({ onOpen }: { onOpen: (character: Character) => void }) {
  const [published,setPublished]=useState<Character[]>([]); const [discoveryError,setDiscoveryError]=useState("");
  useEffect(()=>{api<{characters:Character[]}>("/api/characters?scope=published").then((data)=>setPublished(data.characters)).catch((e)=>setDiscoveryError(e instanceof Error?e.message:"Discovery is unavailable"));},[]);
  async function toggleLike(character:Character){try{if(character.likedByViewer)await api(`/api/likes?characterId=${character.id}`,{method:"DELETE"});else await api("/api/likes",{method:"POST",body:JSON.stringify({characterId:character.id})});setPublished((items)=>items.map((item)=>item.id===character.id?{...item,likedByViewer:!item.likedByViewer,likeCount:Math.max(0,(item.likeCount||0)+(item.likedByViewer?-1:1))}:item));}catch(e){setDiscoveryError(e instanceof Error?e.message:"Could not update like");}}
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Discover roleplay characters</span><h1>Home</h1><p>Browse published cards from other creators. Your own characters and every private story live in Chats.</p></div></header><div className="feed-section-heading"><strong>Discover</strong><span>{published.length} published</span></div>{discoveryError&&<div className="form-error discovery-error">{discoveryError}</div>}<div className="feed-grid">{published.map((character)=><article key={character.id} className="feed-card published-card" role="button" tabIndex={0} onClick={()=>onOpen(character)} onKeyDown={(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onOpen(character);}}}><div className="feed-card-art" style={{"--accent":character.accent} as React.CSSProperties}>{avatarSource(characterAvatarBucket,character.avatarPath,character.avatarUrl)?<img src={avatarSource(characterAvatarBucket,character.avatarPath,character.avatarUrl)} alt=""/>:<span>{initials(character.name)}</span>}<em>{character.nsfwEnabled?"18+":"SFW"}</em></div><div className="feed-card-copy"><span className="eyebrow">{character.creator?.displayName||character.creator?.username||"Afterglow creator"}</span><strong>{character.name}</strong><small>{character.likeCount||0} likes · {character.alternateGreetings.length+(character.greeting?1:0)} openings</small></div><button className={character.likedByViewer?"card-like liked":"card-like"} aria-label={character.likedByViewer?`Unlike ${character.name}`:`Like ${character.name}`} onClick={(e)=>{e.stopPropagation();void toggleLike(character);}}>{character.likedByViewer?"♥":"♡"}</button></article>)}{!published.length&&!discoveryError&&<div className="empty-library-note">No creators have published a character yet. Your private cards remain available in Chats.</div>}</div></section>;
}

function PlaceholderView({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <section className="placeholder-view"><span>{icon}</span><h1>{title}</h1><p>{text}</p></section>;
}

function LikedCharacters({ onOpen }: { onOpen: (character: Character) => void }) {
  const [characters,setCharacters]=useState<Character[]|null>(null); const [error,setError]=useState("");
  useEffect(()=>{api<{characters:Character[]}>("/api/likes").then((data)=>setCharacters(data.characters)).catch((e)=>setError(e instanceof Error?e.message:"Could not load likes"));},[]);
  if(error)return <PlaceholderView icon="♡" title="Could not load likes" text={error}/>;
  if(!characters)return <PlaceholderView icon="♡" title="Loading your likes" text="Collecting your saved public characters…"/>;
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Saved to your account</span><h1>Likes</h1><p>Public and unlisted character cards you want to find again. Their creators never see your private chats.</p></div></header><div className="feed-grid">{characters.map((character)=><button key={character.id} className="feed-card" onClick={()=>onOpen(character)}><div className="feed-card-art" style={{"--accent":character.accent} as React.CSSProperties}>{avatarSource(characterAvatarBucket,character.avatarPath,character.avatarUrl)?<img src={avatarSource(characterAvatarBucket,character.avatarPath,character.avatarUrl)} alt=""/>:<span>{initials(character.name)}</span>}<em>{character.nsfwEnabled?"18+":"SFW"}</em></div><div className="feed-card-copy"><span className="eyebrow">{character.creator?.displayName||character.creator?.username||"Creator"}</span><strong>{character.name}</strong><small>{character.likeCount||0} likes · {character.alternateGreetings.length+(character.greeting?1:0)} openings</small></div></button>)}{!characters.length&&<div className="empty-library-note">You have not liked any published characters yet.</div>}</div></section>;
}

function AccountProfile({ profile, onSaved }: { profile: Profile | null; onSaved: (profile: Profile) => void }) {
  const [username,setUsername]=useState(profile?.username||""); const [displayName,setDisplayName]=useState(profile?.displayName||""); const [bio,setBio]=useState(profile?.bio||""); const [avatarPath,setAvatarPath]=useState(profile?.avatarPath||""); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [notice,setNotice]=useState("");
  useEffect(()=>{if(profile){setUsername(profile.username);setDisplayName(profile.displayName);setBio(profile.bio);setAvatarPath(profile.avatarPath);}},[profile]);
  async function save(){setBusy(true);setError("");setNotice("");try{const data=await api<{profile:Profile}>("/api/profile",{method:"PATCH",body:JSON.stringify({username,displayName,bio,avatarPath})});onSaved(data.profile);setNotice("Profile saved.");}catch(e){setError(e instanceof Error?e.message:"Could not save profile");}finally{setBusy(false);}}
  const source=avatarSource(profileAvatarBucket,avatarPath,"");
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Your Afterglow account</span><h1>Profile</h1><p>This is your creator identity. It is separate from the personas you use inside stories.</p></div></header><section className="modal document-editor account-profile-card"><div className="document-form"><div className="persona-image-row"><div className="persona-preview">{source?<img src={source} alt=""/>:<span>{initials(displayName)}</span>}</div><label className="secondary file-button">↑ Choose image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;try{setAvatarPath(await uploadAvatar(file,profileAvatarBucket));}catch(err){setError(err instanceof Error?err.message:"Image upload failed");}finally{e.target.value="";}}}/></label></div><label>Display name<input value={displayName} onChange={(e)=>setDisplayName(e.target.value)} maxLength={80}/></label><label>Creator username<input value={username} onChange={(e)=>setUsername(e.target.value.toLowerCase())} maxLength={30} placeholder="your_username"/><small>Setting a username opts this profile into public creator attribution. Leave it blank to stay private.</small></label><label>Bio<textarea rows={8} value={bio} onChange={(e)=>setBio(e.target.value)} maxLength={2000} placeholder="What you create, your preferred genres, and anything visitors should know…"/></label>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="form-error">{error}</div>}</div><footer><span className="footer-spacer"/><button className="primary" disabled={busy||!displayName.trim()} onClick={()=>void save()}>{busy?"Saving…":"Save profile"}</button></footer></section></section>;
}

function WorldLibrary({ worlds, onChange }: { worlds: WorldWithCount[]; onChange: () => void }) {
  const [editing,setEditing] = useState<World | null | "new">(null); const [name,setName] = useState(""); const [description,setDescription] = useState(""); const [content,setContent] = useState(""); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  function open(world?: World) { setEditing(world ?? "new"); setName(world?.name ?? ""); setDescription(world?.description ?? ""); setContent(world?.content ?? ""); setError(""); }
  async function save() { setBusy(true); setError(""); try { await api(editing === "new" ? "/api/worlds" : `/api/worlds/${editing!.id}`,{method:editing === "new"?"POST":"PATCH",body:JSON.stringify({name,description,content})}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Could not save world"); } finally { setBusy(false); } }
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Reusable canon</span><h1>World</h1><p>Write lore once, then attach the same document to any characters that live there.</p></div><button className="primary" onClick={() => open()}>＋ New world</button></header><div className="document-grid">{worlds.map((world) => <article key={world.id} className="document-card"><span className="document-icon">▤</span><div><strong>{world.name}</strong><p>{world.description || compactMessagePreview(world.content,140)}</p><small>{world.content.length.toLocaleString()} characters · used by {world.characterCount ?? 0} cards</small></div><button onClick={() => open(world)}>Edit</button></article>)}{!worlds.length && <div className="empty-library-note">No worlds yet. Create lore, rules, locations, factions, or setting documents here.</div>}</div>{editing && <div className="modal-backdrop" onMouseDown={(e) => { if(e.currentTarget===e.target)setEditing(null); }}><section className="modal document-editor"><header><div><span className="eyebrow">World document</span><h2>{editing === "new" ? "Create a reusable world" : `Edit ${editing.name}`}</h2></div><button className="icon-button" onClick={() => setEditing(null)}>×</button></header><div className="document-form"><label>World name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tower of Babel" /></label><label>Short description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Setting, rules, factions, locations…" /></label><label>World canon<textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18} maxLength={100000} placeholder="Everything characters should consistently know about this world…" /></label><small>{content.length.toLocaleString()} / 100,000</small>{error && <div className="form-error">{error}</div>}</div><footer>{editing !== "new" && <button className="danger-button" disabled={busy} onClick={async () => { if(!window.confirm(`Delete “${editing.name}”? It will detach from every character.`))return; setBusy(true); try { await api(`/api/worlds/${editing.id}`,{method:"DELETE"}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Delete failed"); setBusy(false); } }}>⌫ Delete</button>}<span className="footer-spacer"/><button className="secondary" onClick={() => setEditing(null)}>Cancel</button><button className="primary" disabled={busy||!name.trim()||!content.trim()} onClick={() => void save()}>{busy?"Saving…":"Save world"}</button></footer></section></div>}</section>;
}

function WorldPicker({character,worlds,onClose,onCreated,onSaved}:{character:Character;worlds:WorldWithCount[];onClose:()=>void;onCreated:(world:WorldWithCount)=>void;onSaved:(character:Character)=>void}) {
  const [selected,setSelected]=useState<string[]>(character.worldIds); const [creating,setCreating]=useState(false); const [name,setName]=useState(""); const [description,setDescription]=useState(""); const [content,setContent]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  async function create(){setBusy(true);setError("");try{const data=await api<{world:World}>("/api/worlds",{method:"POST",body:JSON.stringify({name,description,content,visibility:"private"})});const world={...data.world,characterCount:0};onCreated(world);setSelected((items)=>[...items,world.id]);setCreating(false);setName("");setDescription("");setContent("");}catch(e){setError(e instanceof Error?e.message:"Could not create world");}finally{setBusy(false);}}
  async function save(){setBusy(true);setError("");try{const data=await api<{character:Character}>(`/api/characters/${character.id}`,{method:"PATCH",body:JSON.stringify({...characterDraft(character),worldIds:selected})});onSaved(data.character);}catch(e){setError(e instanceof Error?e.message:"Could not attach worlds");setBusy(false);}}
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e)=>{if(e.currentTarget===e.target)onClose();}}><aside className="memory-drawer picker-drawer"><header><div><span className="eyebrow">Character canon</span><h2>Worlds for {character.name}</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="picker-body"><p>Worlds remain attached to the character, so every story with this character shares the same canon.</p><div className="world-picker-list">{worlds.map((world)=><label key={world.id} className={selected.includes(world.id)?"selected":""}><input type="checkbox" checked={selected.includes(world.id)} onChange={(e)=>setSelected(e.target.checked?[...selected,world.id]:selected.filter((id)=>id!==world.id))}/><span><strong>{world.name}</strong><small>{world.description||compactMessagePreview(world.content,130)}</small></span></label>)}</div>{!worlds.length&&!creating&&<div className="empty-library-note">Create a world here, then it will be attached to this character.</div>}{creating?<div className="inline-create"><label>World name<input value={name} onChange={(e)=>setName(e.target.value)}/></label><label>Short description<input value={description} onChange={(e)=>setDescription(e.target.value)}/></label><label>World canon<textarea rows={8} value={content} onChange={(e)=>setContent(e.target.value)}/></label><div><button className="secondary" onClick={()=>setCreating(false)}>Cancel</button><button className="primary" disabled={busy||!name.trim()||!content.trim()} onClick={()=>void create()}>{busy?"Creating…":"Create & attach"}</button></div></div>:<button className="secondary create-from-picker" onClick={()=>setCreating(true)}>＋ Create world</button>}{error&&<div className="form-error">{error}</div>}</div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={()=>void save()}>{busy?"Saving…":"Save worlds"}</button></footer></aside></div>;
}

function PersonaLibrary({ personas, onClose, onChange }: { personas: Persona[]; onClose: () => void; onChange: () => void }) {
  const [editing,setEditing] = useState<Persona | null | "new">(null); const [name,setName] = useState(""); const [description,setDescription] = useState(""); const [avatarUrl,setAvatarUrl] = useState(""); const [avatarPath,setAvatarPath] = useState(""); const [accent,setAccent] = useState("#e879a9"); const [isDefault,setIsDefault] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  function open(persona?: Persona) { setEditing(persona ?? "new"); setName(persona?.name ?? ""); setDescription(persona?.description ?? ""); setAvatarUrl(persona?.avatarUrl ?? ""); setAvatarPath(persona?.avatarPath ?? ""); setAccent(persona?.accent ?? "#e879a9"); setIsDefault(persona?.isDefault ?? personas.length === 0); setError(""); }
  async function save() { setBusy(true); setError(""); try { await api(editing === "new"?"/api/personas":`/api/personas/${editing!.id}`,{method:editing === "new"?"POST":"PATCH",body:JSON.stringify({name,description,avatarUrl,avatarPath,accent,isDefault})}); setEditing(null); onChange(); } catch(e) { setError(e instanceof Error?e.message:"Could not save persona"); } finally { setBusy(false); } }
  const preview = avatarSource(profileAvatarBucket, avatarPath, avatarUrl);
  return <section className="library-view"><header className="library-header"><div><span className="eyebrow">Who you enter the story as</span><h1>Personas</h1><p>Create different identities, appearances, pronouns, and backgrounds, then choose one independently for every chat.</p></div><div className="library-header-actions"><button className="primary" onClick={() => open()}>＋ New persona</button><button className="icon-button library-close" aria-label="Close personas" onClick={onClose}>×</button></div></header><div className="persona-grid">{personas.map((persona) => <button key={persona.id} className="persona-card" onClick={() => open(persona)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available for any chat"}</small><p>{compactMessagePreview(persona.description||"No profile details yet.",120)}</p></span></button>)}</div>{editing && <div className="modal-backdrop" onMouseDown={(e) => { if(e.currentTarget===e.target)setEditing(null); }}><section className="modal document-editor persona-editor"><header><div><span className="eyebrow">Persona</span><h2>{editing === "new"?"Create yourself for a story":`Edit ${editing.name}`}</h2></div><button className="icon-button" onClick={() => setEditing(null)}>×</button></header><div className="document-form"><div className="persona-image-row"><div className="persona-preview" style={{"--accent":accent} as React.CSSProperties}>{preview?<img src={preview} alt=""/>:<span>{initials(name)}</span>}</div><label className="secondary file-button">↑ Choose image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async(e)=>{const file=e.target.files?.[0];if(!file)return;try{setAvatarPath(await uploadAvatar(file,profileAvatarBucket));}catch(err){setError(err instanceof Error?err.message:"Image upload failed");}finally{e.target.value="";}}}/></label><input className="color-input" type="color" aria-label="Persona accent" value={accent} onChange={(e)=>setAccent(e.target.value)}/></div><label>Persona name<input value={name} onChange={(e)=>setName(e.target.value)} placeholder="Name used in chat"/></label><label>Persona description<textarea value={description} onChange={(e)=>setDescription(e.target.value)} rows={10} placeholder="Appearance, pronouns, age, personality, abilities, history, relationships, and anything characters should know…"/></label><label className="toggle-row persona-default-row"><span><strong>Default persona</strong><small>Automatically selected for new chats.</small></span><input type="checkbox" checked={isDefault} onChange={(e)=>setIsDefault(e.target.checked)}/></label>{error&&<div className="form-error">{error}</div>}</div><footer>{editing!=="new"&&<button className="danger-button" disabled={busy||editing.isDefault} title={editing.isDefault?"Choose another default persona first":"Delete persona"} onClick={async()=>{if(!window.confirm(`Delete persona “${editing.name}”? Existing chats will fall back to your default persona.`))return;setBusy(true);try{await api(`/api/personas/${editing.id}`,{method:"DELETE"});setEditing(null);onChange();}catch(e){setError(e instanceof Error?e.message:"Delete failed");setBusy(false);}}}>⌫ Delete</button>}<span className="footer-spacer"/><button className="secondary" onClick={()=>setEditing(null)}>Cancel</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void save()}>{busy?"Saving…":"Save persona"}</button></footer></section></div>}</section>;
}

function PersonaAvatar({ persona }: { persona: Persona }) { const source = avatarSource(profileAvatarBucket, persona.avatarPath, persona.avatarUrl); return <div className="persona-preview" style={{"--accent":persona.accent} as React.CSSProperties}>{source?<img src={source} alt=""/>:<span>{initials(persona.name)}</span>}</div>; }

type ChoiceOption = { value: string; label: string; description?: string };

function ChoiceField({ label, value, options, onChange, compact = false }: { label: string; value: string; options: ChoiceOption[]; onChange: (value: string) => void; compact?: boolean }) {
  const [open,setOpen] = useState(false);
  const selected = options.find((option)=>option.value===value) ?? options[0];
  return <div className={`choice-field ${compact?"compact":""}`}><span className="field-label">{label}</span><button type="button" className="choice-trigger" onClick={()=>setOpen(true)}><span><strong>{selected?.label||"Choose"}</strong>{selected?.description&&<small>{selected.description}</small>}</span><b>⌄</b></button>{open&&<div className="choice-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)setOpen(false);}}><section className="choice-modal" role="dialog" aria-modal="true" aria-label={label}><header><div><span className="eyebrow">Choose an option</span><h3>{label}</h3></div><button type="button" className="icon-button" onClick={()=>setOpen(false)}>×</button></header><div className="choice-options">{options.map((option)=><button type="button" key={option.value} className={option.value===value?"selected":""} onClick={()=>{onChange(option.value);setOpen(false);}}><span className="choice-radio">{option.value===value?"●":"○"}</span><span><strong>{option.label}</strong>{option.description&&<small>{option.description}</small>}</span></button>)}</div></section></div>}</div>;
}

function PersonaPicker({ personas, selectedId, onClose, onManage, onCreated, onSave }: { personas: Persona[]; selectedId: string | null; onClose: () => void; onManage: () => void; onCreated:(persona:Persona)=>void; onSave: (personaId: string | null) => Promise<void> }) {
  const [pending,setPending] = useState<string|null>(selectedId); const [busy,setBusy] = useState(false); const [creating,setCreating]=useState(false); const [name,setName]=useState(""); const [description,setDescription]=useState(""); const [error,setError]=useState("");
  async function create(){setBusy(true);setError("");try{const data=await api<{persona:Persona}>("/api/personas",{method:"POST",body:JSON.stringify({name,description,avatarUrl:"",avatarPath:"",accent:"#e879a9",isDefault:personas.length===0})});onCreated(data.persona);setPending(data.persona.id);setCreating(false);}catch(e){setError(e instanceof Error?e.message:"Could not create persona");}finally{setBusy(false);}}
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)onClose();}}><aside className="memory-drawer picker-drawer persona-picker"><header><div><span className="eyebrow">This story</span><h2>Choose persona</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="picker-body"><p>Choose who you are in this chat. Changing persona does not reset its messages or memories.</p><div className="persona-picker-list">{personas.map((persona)=><button key={persona.id} className={pending===persona.id?"selected":""} onClick={()=>setPending(persona.id)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available for any chat"}</small><p>{compactMessagePreview(persona.description||"No profile details yet.",150)}</p></span><b>{pending===persona.id?"✓":""}</b></button>)}</div>{creating?<div className="inline-create"><label>Persona name<input autoFocus value={name} onChange={(e)=>setName(e.target.value)}/></label><label>What should characters know?<textarea rows={6} value={description} onChange={(e)=>setDescription(e.target.value)}/></label><div><button className="secondary" onClick={()=>setCreating(false)}>Cancel</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void create()}>{busy?"Creating…":"Create persona"}</button></div></div>:<div className="picker-create-actions"><button className="secondary create-from-picker" onClick={()=>setCreating(true)}>＋ Create persona</button><button className="secondary create-from-picker" onClick={onManage}>✎ Manage</button></div>}{!personas.length&&!creating&&<div className="empty-library-note">Create your first persona to tell characters who they are speaking with.</div>}{error&&<div className="form-error">{error}</div>}</div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!pending} onClick={async()=>{setBusy(true);try{await onSave(pending);}finally{setBusy(false);}}}>{busy?"Saving…":"Use persona"}</button></footer></aside></div>;
}

function ModelPicker({ catalog, conversation, onClose, onSave }: { catalog: ModelCatalog; conversation: Conversation; onClose: () => void; onSave: (changes: Pick<Conversation,"providerId"|"modelId"|"rpEngineId">) => Promise<void> }) {
  const [engineId,setEngineId] = useState(conversation.rpEngineId); const [providerId,setProviderId] = useState(conversation.providerId); const [modelId,setModelId] = useState(conversation.modelId); const [busy,setBusy] = useState(false); const [advanced,setAdvanced] = useState(false); const [favorites,setFavorites] = useState<string[]>([]);
  const [section,setSection] = useState<"discover"|"favorites">("discover"); const [searchOpen,setSearchOpen] = useState(false); const [search,setSearch] = useState("");
  useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem("afterglow_favorite_models")||"[]");if(Array.isArray(saved))setFavorites(saved.filter((value):value is string=>typeof value==="string"));}catch{}},[]);
  const models = catalog.models.filter((model)=>model.providerId===providerId);
  const selectedModel = models.find((model)=>model.id===modelId) ?? models[0];
  const normalizedSearch=search.trim().toLowerCase();
  const engines = catalog.engines.filter((engine)=>{
    if (!searchOpen && section==="favorites" && !favorites.includes(engine.id)) return false;
    if (!normalizedSearch) return true;
    return [engine.label,engine.description,...engine.tags].some((value)=>value.toLowerCase().includes(normalizedSearch));
  });
  function toggleFavorite(id:string){setFavorites((current)=>{const next=current.includes(id)?current.filter((item)=>item!==id):[...current,id];localStorage.setItem("afterglow_favorite_models",JSON.stringify(next));return next;});}
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)onClose();}}><aside className="memory-drawer picker-drawer model-picker"><header><div><span className="eyebrow">Writer for this story</span><h2>Choose model</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="picker-body"><p>Each model is an Afterglow roleplay profile tuned for a different style. Your character, world, persona, history, and long-term memory remain unchanged when you switch.</p><div className={`model-navigation ${searchOpen?"searching":""}`}>{searchOpen?<><input autoFocus value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Search models" aria-label="Search models"/><button className="icon-button" aria-label="Close search" onClick={()=>{setSearchOpen(false);setSearch("");}}>×</button></>:<><button className={section==="discover"?"active":""} onClick={()=>setSection("discover")}>Discover</button><button className={section==="favorites"?"active":""} onClick={()=>setSection("favorites")}>Favorites</button><button className="model-search-button" aria-label="Search models" onClick={()=>setSearchOpen(true)}>⌕</button></>}</div><div className="model-card-list">{engines.map((engine)=><article key={engine.id} className={engine.id===engineId?"model-card selected":"model-card"}><button className="model-card-main" onClick={()=>setEngineId(engine.id)}><span className="model-radio">{engine.id===engineId?"●":"○"}</span><span><strong>{engine.label}</strong><small>{engine.description}</small><span className="model-tags">{engine.adult&&<em>18+ RP</em>}{engine.tags.map((tag)=><i key={tag}>{tag}</i>)}</span></span></button><button className={favorites.includes(engine.id)?"model-favorite active":"model-favorite"} aria-label={favorites.includes(engine.id)?`Remove ${engine.label} from favorites`:`Favorite ${engine.label}`} onClick={()=>toggleFavorite(engine.id)}>☆</button></article>)}</div>{!engines.length&&<div className="empty-library-note">{searchOpen?"No models match that search.":"Favorite a model in Discover and it will appear here."}</div>}<button className="advanced-model-toggle" onClick={()=>setAdvanced((value)=>!value)}><span><strong>Base intelligence</strong><small>{selectedModel?.label||conversation.modelId} · advanced</small></span><b>{advanced?"⌃":"⌄"}</b></button>{advanced&&<div className="advanced-model-panel"><p>The RP model controls style and behavior. The base intelligence is the provider model underneath it.</p><ChoiceField label="Provider" value={providerId} onChange={(value)=>{setProviderId(value);setModelId(catalog.models.find((model)=>model.providerId===value)?.id||"");}} options={catalog.providers.map((provider)=>({value:provider.id,label:provider.label}))}/><ChoiceField label="Base intelligence" value={modelId} onChange={setModelId} options={models.map((model)=>({value:model.id,label:model.label,description:model.description}))}/></div>}</div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!selectedModel} onClick={async()=>{if(!selectedModel)return;setBusy(true);try{await onSave({providerId,modelId:selectedModel.id,rpEngineId:engineId});}finally{setBusy(false);}}}>{busy?"Switching…":"Use model"}</button></footer></aside></div>;
}

function InstructionsDrawer({ conversation, onClose, onSave }: { conversation: Conversation; onClose: () => void; onSave: (value: { instructionPresets: ChatInstructionPreset[]; customInstructions: string }) => Promise<void> }) {
  const [presets,setPresets] = useState<ChatInstructionPreset[]>(conversation.instructionPresets); const [custom,setCustom] = useState(conversation.customInstructions); const [busy,setBusy] = useState(false);
  const choices: { id: ChatInstructionPreset; title: string; text: string }[] = [
    {id:"reduce_repetition",title:"Reduce repetition",text:"Avoid recycled phrases, gestures, and emotional beats."},
    {id:"stay_focused",title:"Stay focused",text:"Keep replies centered on the latest message and immediate scene."},
    {id:"advance_plot",title:"Advance the plot",text:"Add natural consequences, discoveries, or complications when appropriate."},
  ];
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e)=>{if(e.currentTarget===e.target)onClose();}}><aside className="memory-drawer instruction-drawer"><header><div><span className="eyebrow">This chat only</span><h2>Instructions</h2></div><button className="icon-button" onClick={onClose}>×</button></header><div className="instruction-body"><p>These directions are added beneath the character, world, persona, and continuity context for this story only.</p>{choices.map((choice)=><label key={choice.id} className={presets.includes(choice.id)?"selected":""}><input type="checkbox" checked={presets.includes(choice.id)} onChange={(e)=>setPresets(e.target.checked?[...presets,choice.id]:presets.filter((item)=>item!==choice.id))}/><span><strong>{choice.title}</strong><small>{choice.text}</small></span></label>)}<label className="custom-instruction">Custom instruction<textarea rows={7} maxLength={3000} value={custom} onChange={(e)=>setCustom(e.target.value)} placeholder="For example: Keep replies concise during dialogue-heavy scenes…"/><small>{custom.length.toLocaleString()} / 3,000</small></label></div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={async()=>{setBusy(true);await onSave({instructionPresets:presets,customInstructions:custom});setBusy(false);}}>{busy?"Saving…":"Save instructions"}</button></footer></aside></div>;
}

function SettingsDrawer({ isAdmin, settings, models, catalog, onClose, onSaved, onImported }: { isAdmin:boolean; settings: AppSettings; models: string[]; catalog: ModelCatalog; onClose: () => void; onSaved: (settings: AppSettings) => void; onImported: () => void }) {
  const [form,setForm] = useState(settings); const [usage,setUsage] = useState<UsageResponse | null>(null); const [busy,setBusy] = useState(false); const [error,setError] = useState(""); const [notice,setNotice] = useState("");
  useEffect(() => { if(isAdmin)api<UsageResponse>("/api/usage").then(setUsage).catch(() => undefined); }, [isAdmin]);
  const number = (value: number) => new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(value);
  const usd = (value: number) => new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",minimumFractionDigits:value < 0.01 ? 5 : 2,maximumFractionDigits:value < 0.01 ? 6 : 4}).format(value);
  const usageLabels: Record<string,string> = { chat:"Replies",regenerate:"Regenerations",continue:"Continuations",memory_consolidation:"Memory updates",character_generation:"Character generation/import" };
  async function save() { setBusy(true); setError(""); try { const data = await api<{settings:AppSettings}>("/api/settings",{method:"PATCH",body:JSON.stringify(form)}); onSaved(data.settings); } catch (e) { setError(e instanceof Error ? e.message : "Could not save settings"); setBusy(false); } }
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer settings-drawer">
    <header><div><span className="eyebrow">Instance settings</span><h2>Make it yours</h2></div><button className="icon-button" onClick={onClose}>×</button></header>
    <div className="settings-body">
      <section><span className="eyebrow">Default writer for new chats</span><ChoiceField label="Provider" value={form.providerId} onChange={(providerId) => { const first=catalog.models.find((model)=>model.providerId===providerId); setForm({...form,providerId,model:first?.id||form.model}); }} options={catalog.providers.map((provider)=>({value:provider.id,label:provider.label}))}/><ChoiceField label="Base intelligence" value={form.model} onChange={(value) => { const model=catalog.models.find((item)=>item.id===value); setForm({...form,providerId:model?.providerId||form.providerId,model:value}); }} options={(catalog.models.length?catalog.models.filter((model)=>model.providerId===form.providerId):models.map((id)=>({id,label:id,providerId:form.providerId,description:"",supportsThinking:true}))).map((model)=>({value:model.id,label:model.label,description:model.description}))}/><ChoiceField label="Default RP model" value={form.roleplayPreset} onChange={(value) => setForm({...form,roleplayPreset:value as AppSettings["roleplayPreset"]})} options={catalog.engines.map((engine)=>({value:engine.id,label:engine.label,description:engine.description}))}/><ChoiceField label="Default response length" value={form.responseLength} onChange={(value)=>setForm({...form,responseLength:value as AppSettings["responseLength"]})} options={[{value:"concise",label:"Concise",description:"Tighter replies with fewer beats."},{value:"natural",label:"Natural",description:"Preserves today's pacing as closely as possible."},{value:"detailed",label:"Detailed",description:"Fuller scenes where the moment supports it."}]}/><p className="setting-note">These defaults apply only when a new story is created. Each existing conversation keeps its own writer choices and can switch them from Story without resetting continuity.</p><div className="settings-pair"><label>Creativity <input type="number" min="0" max="2" step="0.05" value={form.temperature} onChange={(e) => setForm({...form,temperature:Number(e.target.value)})} /></label>{isAdmin&&<label>Max reply tokens <input type="number" min="256" max="8000" step="128" value={form.maxTokens} onChange={(e) => setForm({...form,maxTokens:Number(e.target.value)})} /></label>}</div></section>
      {isAdmin&&<section><span className="eyebrow">Memory tuning</span><div className="settings-pair"><label>Recent messages <input type="number" min="8" max="100" value={form.contextMessages} onChange={(e) => setForm({...form,contextMessages:Number(e.target.value)})} /></label><label>Recent context tokens <input type="number" min="4000" max="100000" step="1000" value={form.contextTokenBudget} onChange={(e) => setForm({...form,contextTokenBudget:Number(e.target.value)})} /></label><label>Relevant event slots <input type="number" min="1" max="20" value={form.memoryLimit} onChange={(e) => setForm({...form,memoryLimit:Number(e.target.value)})} /></label><label>Memory context tokens <input type="number" min="1000" max="30000" step="500" value={form.memoryTokenBudget} onChange={(e) => setForm({...form,memoryTokenBudget:Number(e.target.value)})} /></label><label>Consolidate every N messages <input type="number" min="6" max="50" value={form.consolidationInterval} onChange={(e) => setForm({...form,consolidationInterval:Number(e.target.value)})} /></label></div><p className="setting-note">The permanent archive has no reply-count cap. The token budget controls how much is recalled at once; active promises, boundaries, and unresolved loops get protected priority.</p></section>}
      {isAdmin&&usage && <section><span className="eyebrow">Complete usage & cost ledger</span><div className="usage-grid"><div><strong>{number(usage.usage.requests)}</strong><small>API calls</small></div><div><strong>{number(usage.usage.promptTokens)}</strong><small>input tokens</small></div><div><strong>{number(usage.usage.completionTokens)}</strong><small>output tokens</small></div><div><strong>{number(usage.usage.cacheHitTokens)}</strong><small>cached input</small></div><div><strong>{usd(usage.usage.estimatedCostUsd)}</strong><small>total estimated cost</small></div><div><strong>{usd(usage.costPer100UserMessages||0)}</strong><small>cost / 100 user messages</small></div></div><div className="usage-breakdown">{usage.byType.map((item) => <div key={item.key}><span><strong>{usageLabels[item.key] ?? item.key}</strong><small>{item.requests} calls · {number(item.promptTokens + item.completionTokens)} tokens</small></span><b>{usd(item.estimatedCostUsd)}</b></div>)}</div><div className="usage-models">{usage.byModel.map((item) => <span key={`model:${item.key}`}>{item.key}: <strong>{usd(item.estimatedCostUsd)}</strong></span>)}{usage.byEngine.map((item)=><span key={`engine:${item.key}`}>{item.key} engine: <strong>{usd(item.estimatedCostUsd)}</strong></span>)}{usage.byFunding.map((item)=><span key={`funding:${item.key}`}>{item.key}: <strong>{usd(item.estimatedCostUsd)}</strong></span>)}</div><p className="setting-note">Includes replies, regenerate, continue, memory consolidation, and character generation/import.</p></section>}
      <section><span className="eyebrow">Backup & portability</span><div className="data-actions"><a className="secondary" href="/api/backup" download>↓ Export JSON backup</a><label className="secondary file-button">↑ Import backup<input type="file" accept="application/json,.json" onChange={async (e) => { const file=e.target.files?.[0]; if(!file) return; if(!window.confirm("Import this backup as additional characters and chats?")) return; setBusy(true); setError(""); try { const result=await api<{imported:Record<string,number>}>("/api/backup",{method:"POST",body:await file.text()}); setNotice(`Imported ${result.imported.characters} characters and ${result.imported.messages} messages.`); await onImported(); } catch(err) { setError(err instanceof Error?err.message:"Import failed"); } finally { setBusy(false); e.target.value=""; } }} /></label></div><p className="setting-note">Backups include your profiles, characters, worlds, chats, and settings{isAdmin?", including continuity archives":""}—never passwords or API keys.</p></section>
      {notice && <div className="success-note">{notice}</div>}{error && <div className="form-error">{error}</div>}
    </div>
    <footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void save()}>{busy?"Working…":"Save settings"}</button></footer>
  </aside></div>;
}
