"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {useRouter, useSearchParams} from "next/navigation";
import type { AppSettings, Character, Conversation, Memory, MemoryArc, Message, ModelCatalog, Persona, Profile, SceneState, World, WorldSummary } from "@/lib/types";
import { api } from "@/lib/api-client";
import { creationKindLine, creationSubject, creationTitle, inlineTitle } from "@/lib/creation";
import { CreationStudio, type StudioWorld } from "@/components/studio";
import { DiscoveryFeed } from "@/components/feed";
import { YourCreations } from "@/components/creations";
import { WorldsHub, WorldEditor } from "@/components/worlds";
import { RichMessage, StyledMessage, openingBlocksFor } from "@/components/rich";
import {
  ArrowDown, ArrowUp, Bell, BookMarked, BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight,
  Compass, Eraser, FileText, GitBranch, Globe2, LoaderCircle, LogOut, MessagesSquare, MoreHorizontal,
  Flag, Gauge, Pencil, Play, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Star, Trash2,
  TriangleAlert, Trophy, UserRound, Users, X,
} from "lucide-react";
import { ChatsView } from "./ChatsView";
import { InstructionsSheet } from "./InstructionsSheet";
import { LibraryView } from "./LibraryView";
import { MemoryFeedback } from "./MemoryFeedback";
import { PersonasView } from "./PersonasView";
import { NotificationsView } from "./NotificationsView";
import { ProfileView } from "./ProfileView";
import { SettingsSheet } from "./SettingsSheet";
import { ShellNavProvider } from "./ShellNav";
import { RankingsView } from "@/components/rankings";
import { AdminReports } from "@/components/admin/AdminReports";
import { unreadLabel } from "@/lib/notifications";
import { clearUnreadNotifications, useUnreadNotifications } from "@/lib/notification-state";
import { activeInstructionCount, instructionSummary } from "@/lib/chat-instructions";
import { forgetAllStoredDrafts } from "@/components/studio/drafts";
import { compactMessagePreview } from "@/lib/message-format";
import { supabaseBrowser, supabaseBrowserConfigured } from "@/lib/supabase/client";
import { AppMenuButton, IconButton, SelectField, SettingsChoiceRow, type SelectOption } from "@/components/ui";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "@/lib/storage";
import { closeStorySurface, closedStoryNavigation, openChatChild, openStory, openStoryChild, type StoryChild } from "@/lib/story-navigation";
import { claimDepth, justCreatedParam, rootDepth } from "@/lib/back-navigation";
import { chatHref, commandFromSearch, isCurrentHref, routeFromSearch, viewHref, type AppView, type ShellView } from "@/lib/shell-route";
import { savedCreationDestination } from "@/lib/creation-actions";
import { mergeCreationLists } from "@/lib/shell-library";
import { acceptsResponse, adoptChatView, chatFailed, chatLoaded, clearChatView, emptyChatView, openChatView, type ChatView } from "@/lib/chat-view";

type WorldWithCount = StudioWorld;


const defaultSettings: AppSettings = {
  ownerName: "You", ownerProfile: "", providerId: "deepseek", model: "deepseek-v4-flash", roleplayPreset: "immersive", responseLength: "natural", temperature: 0.95, maxTokens: 1800,
  contextMessages: 30, contextTokenBudget: 12000, consolidationInterval: 10, memoryLimit: 8, memoryTokenBudget: 6000,
};

function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?"; }
function time(value: string) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
/** One settled `/api/characters` response, as the merge expects to read it. */
function unwrap(settled: PromiseSettledResult<{ characters: Character[] }>) {
  return settled.status === "fulfilled"
    ? { ok: true as const, value: settled.value.characters }
    : { ok: false as const, reason: settled.reason };
}
function memoriesUrl(characterId: string, conversationId?: string | null) { const params = new URLSearchParams({ characterId }); if (conversationId) params.set("conversationId",conversationId); return `/api/memories?${params}`; }
export default function AppShell() {
  const router=useRouter();
  /*
   * The address, on the FIRST render rather than in an effect after it.
   *
   * This is the whole of the "tapping Chat flashes the Creation Studio"
   * report. The shell used to start on `home`, apply the route in an effect
   * that could not run until the session request had resolved, and fall
   * through to the studio's empty state in between — so navigating into a chat
   * painted Discovery, then "Create someone worth remembering", and only then
   * the story.
   *
   * `useSearchParams` is what makes reading it here safe. The page is rendered
   * inside a Suspense boundary (see src/app/page.tsx), so the server renders
   * the boundary's fallback and the browser renders THIS component with the
   * real address already in hand. There is no first render that does not know
   * where it is, and therefore no frame of some other section of the app.
   */
  const searchParams = useSearchParams();
  const [bootRoute] = useState(() => routeFromSearch(searchParams.toString()));
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModerator,setIsModerator]=useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ageAccepted, setAgeAccepted] = useState<boolean | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(bootRoute?.view === "chat" ? bootRoute.characterId : null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatIndex, setChatIndex] = useState<Conversation[]>([]);
  /**
   * The chat view's own state, as one value.
   *
   * Which story is being shown, which request asked for it, and what has
   * arrived — kept together because they have to change together. See
   * src/lib/chat-view.ts for the two bugs that come from letting them drift:
   * the previous story's messages surviving a switch, and a slow answer landing
   * on a chat the reader has already left.
   *
   * `conversation` and `messages` are read exactly as they were, and the two
   * setters below keep every existing call site working unchanged.
   */
  const [chatView, setChatView] = useState<ChatView>(emptyChatView);
  const conversation = chatView.conversation;
  const messages = chatView.messages;
  const setConversation = useCallback((value: Conversation | null | ((current: Conversation | null) => Conversation | null)) => {
    setChatView((view) => ({ ...view, conversation: typeof value === "function" ? value(view.conversation) : value }));
  }, []);
  const setMessages = useCallback((value: Message[] | ((current: Message[]) => Message[])) => {
    setChatView((view) => ({ ...view, messages: typeof value === "function" ? value(view.messages) : value }));
  }, []);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [worlds, setWorlds] = useState<WorldWithCount[]>([]);
  const [composer, setComposer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [storyNavigation, setStoryNavigation] = useState(closedStoryNavigation);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState<AppView>(bootRoute?.view ?? "home");
  const [studioStartSection, setStudioStartSection] = useState<"basics" | "definition" | "world">("basics");
  // The world being authored: "new" for a fresh one, a record for an edit.
  const [editingWorld, setEditingWorld] = useState<WorldSummary | World | "new" | null>(null);
  const [composerToolsOpen, setComposerToolsOpen] = useState(false);
  /**
   * The worlds attached to the story on screen.
   *
   * Null means "not read yet", which is why the tool row says "In this story"
   * rather than "0 in this story" before it knows. Deliberately NOT fetched
   * when a chat opens: the writer prompt reads this set on the server and the
   * reader only needs the number when they go looking for it, so the request
   * happens when the tools are opened and never on the path into a story.
   */
  const [storyWorlds, setStoryWorlds] = useState<WorldSummary[] | null>(null);
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
  /** A failure of the shell's own lists, shown on whichever surface is open. */
  const [libraryError, setLibraryError] = useState("");
  const [accountNotice,setAccountNotice]=useState("");
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const [sidebarCharacterMenuId,setSidebarCharacterMenuId]=useState<string|null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const [creatingConversation, setCreatingConversation] = useState(false);
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

  /**
   * The blocks belonging to a message, when it is an illustrated opening.
   *
   * Only the first assistant message can be one, and only while it still says
   * exactly what an opening says — an edited or regenerated message is no
   * longer that opening and renders as ordinary text. The conversation itself
   * is untouched by this: the message row holds text, the model receives text,
   * and the pictures are added on the way to the screen.
   */
  const openingBlocks=useCallback((message:Message,index:number)=>{
    if(index!==0||message.role!=="assistant"||!selected)return null;
    return openingBlocksFor(message.content,[
      { text: selected.greeting, blocks: selected.greetingRich },
      ...selected.alternateGreetings.map((text,position)=>({ text, blocks: selected.alternateGreetingsRich[position] ?? [] })),
    ]);
  },[selected]);

  /**
   * Moving between the shell's surfaces is navigation, so it goes through the
   * router — and that now includes opening a chat.
   *
   * The previous sprint gave every named view a real history entry, which is
   * why a creation opened from Your Creations returns there. A CHAT still had
   * none: it was `activeView === "chat"` and nothing else, so the entry
   * underneath a creation page opened from a chat named whatever the reader had
   * last navigated to. Back was not guessing wrongly; there was nothing to
   * guess from. The one path that did carry a chat in the URL then called
   * `replaceState(…, "/")` and deleted it.
   *
   * So `openChat` pushes an address that names the character AND the exact
   * conversation, `applyRoute` reads one back, and the popstate listener below
   * keeps state and address in step in both directions.
   */
  /**
   * Point the chat view at a story, immediately.
   *
   * The previous story's messages are cleared in the SAME state update that
   * changes the selection. That is the whole of the "old chat visible for two
   * seconds" complaint: the transcript used to stay mounted until the new
   * fetch resolved, so for a second or two the app showed one conversation's
   * replies under another conversation's name. An empty, loading chat is a
   * slower-looking screen and a truthful one; the alternative was neither.
   */
  const selectChat=useCallback((characterId:string,conversationId:string|null)=>{
    setSelectedId(characterId);
    setActiveView("chat");
    setChatView((view)=>openChatView(view,characterId,conversationId));
    setStoryNavigation(closedStoryNavigation);
    setEditingMessageId(null); setRecallMessage(null);
    setMemories([]);
    setError("");
  },[]);

  const applyRoute=useCallback((route:ReturnType<typeof routeFromSearch>)=>{
    if(!route)return;
    if(route.view==="chat"){
      selectChat(route.characterId,route.conversationId);
      return;
    }
    setActiveView(route.view);
  },[selectChat]);

  const goToView=useCallback((view:AppView)=>{
    if(view==="chat")return;
    setActiveView(view);
    setSidebarOpen(false);
    const target=viewHref(view);
    // Same view, same entry: tapping the current tab must not stack history.
    if(isCurrentHref(window.location,target))return;
    router.push(target);
  },[router]);
  // `openOwnProfile` is declared above `goToView` so the sidebar can call it,
  // and needs it for the account that has no public page yet. A ref rather
  // than a reorder, because the ordering above is the one the rest of the
  // component depends on.
  /**
   * Opening your own profile means opening your PUBLIC page.
   *
   * "Profile" used to mean the editor, so the one thing a creator could not
   * easily do was look at themselves the way everybody else does. It is a real
   * page at /creators/{username} and this is what goes there; the editor is
   * still one tap away from it, and is still where `?view=profile` lands.
   *
   * An account that has published nothing has no public page yet, so it gets
   * the editor — which is the surface that explains how to get one.
   */
  const ownUsername=profile?.username ?? "";
  const openOwnProfile=useCallback(()=>{
    setSidebarOpen(false);
    if(ownUsername){router.push(`/creators/${ownUsername}`);return;}
    goToView("profile");
  },[ownUsername,router,goToView]);

  const { unread: unreadNotifications } = useUnreadNotifications();
  const profileAvatar = profile?.avatarPath ? avatarSource(profileAvatarBucket, profile.avatarPath, "") : "";

  /**
   * The navigation, as data.
   *
   * Three groups rather than one flat list of ten, and the grouping is the
   * product's own shape rather than a tidy-up: BROWSE is other people's work,
   * LIBRARY is yours, ACCOUNT is you. Every destination that existed before is
   * still here and still in the same relative order.
   *
   * `match` rather than an equality test, because two views can be the same
   * destination — a chat is Chats, and there is nowhere else for it to be.
   */
  const navSections = useMemo(() => [
    {
      id: "browse",
      label: "Browse",
      items: [
        { id: "home", label: "Discover", icon: Compass, match: (view: AppView) => view === "home", open: () => goToView("home") },
        { id: "rankings", label: "Rankings", icon: Trophy, match: (view: AppView) => view === "rankings", open: () => goToView("rankings") },
        { id: "notifications", label: "Notifications", icon: Bell, match: (view: AppView) => view === "notifications", open: () => goToView("notifications") },
      ],
    },
    {
      id: "library",
      label: "Your library",
      items: [
        { id: "chats", label: "Chats", icon: MessagesSquare, match: (view: AppView) => view === "chats" || view === "chat", open: () => goToView("chats") },
        { id: "creations", label: "Creations", icon: Sparkles, match: (view: AppView) => view === "creations", open: () => goToView("creations") },
        { id: "worlds", label: "Worlds", icon: Globe2, match: (view: AppView) => view === "worlds", open: () => goToView("worlds") },
        { id: "saved", label: "Saved", icon: BookMarked, match: (view: AppView) => view === "saved", open: () => goToView("saved") },
      ],
    },
    {
      id: "account",
      label: "Account",
      items: [
        // Profile opens the PUBLIC page. The editor is reached from it, and is
        // still what `?view=profile` resolves to.
        { id: "profile", label: "Profile", icon: UserRound, match: (view: AppView) => view === "profile", open: () => openOwnProfile() },
        { id: "personas", label: "Personas", icon: Users, match: (view: AppView) => view === "personas", open: () => goToView("personas") },
        { id: "settings", label: "Settings", icon: Settings, match: () => false, open: () => { setSettingsOpen(true); setSidebarOpen(false); } },
      ],
    },
    ...(isModerator?[{id:"moderation",label:"Admin",items:[{id:"reports",label:"Reports",icon:Flag,match:(view:AppView)=>view==="reports",open:()=>goToView("reports")}]}]:[]),
  ], [goToView, openOwnProfile,isModerator]);

  /** What a component deep inside a surface uses to navigate; see ShellNav.tsx. */
  const shellNav = useMemo(() => ({ openView: (view: ShellView) => goToView(view) }), [goToView]);

  /**
   * Opening a story.
   *
   * Every route into a chat comes through here — the Chats list, the story
   * drawer, a freshly created conversation — so every one of them leaves the
   * same true record behind. The messages of whatever was open are cleared in
   * the same tick as the selection changes, because a list of somebody else's
   * replies sitting under a new chat's header is not a slower render, it is a
   * wrong one.
   */
  const openChat=useCallback((characterId:string,conversationId?:string|null,options?:{replace?:boolean})=>{
    selectChat(characterId,conversationId ?? null);
    setSidebarOpen(false);
    const target=chatHref(characterId,conversationId);
    if(isCurrentHref(window.location,target))return;
    if(options?.replace)router.replace(target); else router.push(target);
  },[router,selectChat]);

  /**
   * Back and forward inside the shell.
   *
   * A popstate is the only way the address bar changes without this component
   * having asked for it, so it is the only place the route needs to be read
   * back out of the URL. Discovery rewriting its own filters uses
   * `replaceState`, which fires nothing and therefore cannot fight this.
   */
  useEffect(()=>{
    function syncFromUrl(){ applyRoute(routeFromSearch(window.location.search)); }
    window.addEventListener("popstate",syncFromUrl);
    return()=>window.removeEventListener("popstate",syncFromUrl);
  },[applyRoute]);

  /**
   * Loads one story into the chat view.
   *
   * `token` is the sequence number of the request that asked for it. Every
   * write below is guarded by it, so a response that arrives after the reader
   * has moved on is discarded rather than painted over the story they are
   * actually looking at. Passing no token means "this is not a switch" — a
   * refresh of whatever is already open — and applies unconditionally.
   */
  /**
   * Reads one story. Applying it is the caller's decision, because only the
   * caller knows whether the request that asked for it is still the newest one.
   */
  const loadChat = useCallback(async (characterId: string, conversationId?: string) => {
    const query = new URLSearchParams({ characterId });
    if (conversationId) query.set("conversationId", conversationId);
    return api<{ conversations: Conversation[]; conversation: Conversation; messages: Message[] }>(`/api/conversations?${query}`);
  }, []);

  /** The durable memories behind a story, for the administrator's drawer. */
  const loadMemories = useCallback((characterId: string, conversationId?: string | null) => {
    if (!isAdmin) { setMemories([]); return; }
    void api<{ memories: Memory[] }>(memoriesUrl(characterId,conversationId))
      .then((data) => setMemories(data.memories))
      .catch(() => undefined);
  }, [isAdmin]);

  /**
   * Re-reads the story already on screen.
   *
   * A refresh, not a switch: nothing is cleared, because the reader is looking
   * at this conversation and it is still the one they asked for. Guarded on the
   * creation so a refresh cannot land after a switch has moved on.
   */
  const refreshChat = useCallback(async (characterId: string, conversationId?: string) => {
    const data = await loadChat(characterId, conversationId);
    setChatView((view) => view.request?.characterId === characterId
      ? { ...view, conversation: data.conversation, messages: data.messages, loading: false }
      : view);
    setConversations(data.conversations);
    loadMemories(characterId, data.conversation.id);
    return data;
  }, [loadChat, loadMemories]);

  const loadCharacters = useCallback(async () => {
    // Declared inside so the retry recurses on a plain function rather than on
    // the memoised callback, which cannot refer to itself.
    async function attemptLoad(attempt: number): Promise<void> {
      const [owned,chats] = await Promise.allSettled([
        api<{ characters: Character[] }>("/api/characters"),
        api<{ characters: Character[] }>("/api/characters?scope=chats"),
      ]);
      let result!: ReturnType<typeof mergeCreationLists>;
      setCharacters((current) => {
        result = mergeCreationLists(unwrap(owned),unwrap(chats),current);
        return result.characters;
      });
      if (result.failed) {
        // One retry, once. A rotated session cookie or a cold connection pool
        // fails the first request of a burst and succeeds the second.
        if (attempt === 0) { await new Promise((resolve) => window.setTimeout(resolve,350)); return attemptLoad(attempt + 1); }
        const reason = owned.status === "rejected" ? owned.reason : chats.status === "rejected" ? chats.reason : null;
        setLibraryError(reason instanceof Error ? reason.message : "Could not load your creations");
        return;
      }
      if (!result.partial) setLibraryError("");
      const known = result.characters;
      setSelectedId((current) => current && known.some((item) => item.id === current) ? current : known[0]?.id ?? null);
    }
    return attemptLoad(0);
  }, []);

  const loadChatIndex = useCallback(async () => {
    async function attemptLoad(attempt: number): Promise<void> {
      try {
        const data = await api<{ conversations: Conversation[] }>("/api/conversations?scope=all");
        setChatIndex(data.conversations);
      } catch (reason) {
        if (attempt === 0) { await new Promise((resolve) => window.setTimeout(resolve,350)); return attemptLoad(attempt + 1); }
        setLibraryError(reason instanceof Error ? reason.message : "Could not load your stories");
      }
    }
    return attemptLoad(0);
  }, []);

  const loadLibraries = useCallback(async () => {
    const [personaData,worldData] = await Promise.all([
      api<{ personas: Persona[] }>("/api/personas"),
      api<{ worlds: WorldWithCount[] }>("/api/worlds"),
    ]);
    setPersonas(personaData.personas); setWorlds(worldData.worlds);
  }, []);

  /**
   * Bring every cached list back in step, in the background.
   *
   * Never awaited by anything that navigates. A refresh is housekeeping; a
   * navigation is the reader's decision, and one must not wait on the other —
   * which is exactly what produced the delayed post-creation redirect.
   */
  const refreshLibraries = useCallback(() => {
    void loadCharacters();
    void loadChatIndex().catch(() => undefined);
    void loadLibraries().catch(() => undefined);
  }, [loadCharacters, loadChatIndex, loadLibraries]);

  useEffect(() => {
    setAgeAccepted(localStorage.getItem("afterglow_age_verified") === "yes");
    if (!supabaseBrowserConfigured()) { setAuthenticated(false); return; }
    const loadSession = () => api<{ authenticated: boolean; profile: Profile | null; isAdmin?: boolean;isModerator?:boolean }>("/api/session")
      .then((data) => { setAuthenticated(data.authenticated); setProfile(data.profile); setIsAdmin(Boolean(data.isAdmin));setIsModerator(Boolean(data.isModerator)); })
      .catch(() => { setAuthenticated(false); setProfile(null); setIsAdmin(false);setIsModerator(false); });
    void loadSession();
    // Sign-in and sign-out happen in the browser client, so mirror its state.
    // INITIAL_SESSION fires the moment the listener is attached and says only
    // what the call above already asked, so honouring it meant every boot of
    // the shell opened with two identical session requests.
    const { data: listener } = supabaseBrowser().auth.onAuthStateChange((event: string) => {
      if (event === "INITIAL_SESSION") return;
      void loadSession();
    });
    return () => listener.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (authenticated) { void loadCharacters(); void loadChatIndex().catch(() => undefined); void loadLibraries().catch(() => undefined); api<{ settings: AppSettings; models: string[]; catalog: ModelCatalog }>("/api/settings").then((data) => { setSettings({...defaultSettings,...data.settings}); setModels(data.models ?? []); setModelCatalog(data.catalog ?? {providers:[],models:[],engines:[]}); }).catch(() => undefined); } }, [authenticated, loadCharacters, loadChatIndex, loadLibraries]);
  useEffect(()=>{if(!authenticated)return;if(new URLSearchParams(window.location.search).get("verification")==="success"){setAccountNotice("Email verified — welcome to Afterglow.");const timeout=window.setTimeout(()=>setAccountNotice(""),5000);return()=>window.clearTimeout(timeout);}},[authenticated]);
  /**
   * The address the tab arrived on, applied once.
   *
   * Two different things can be in a URL and they are separated here: a ROUTE
   * (what to show) and a COMMAND (what to do — open the studio, open a world
   * editor). A route is applied and left alone; a command is spent and the
   * address is rewritten to the surface it landed on, so a reload does not
   * reopen a form the reader already closed.
   *
   * What is deliberately NOT here any more is the `replaceState(…, "/")` that
   * used to run after opening a chat from a creation page. It rewrote the one
   * entry that recorded which story was open, which is why Back from that
   * chat's creation page went to Discovery. A chat has an address now, and the
   * address is what is kept.
   */
  useEffect(()=>{
    if(!authenticated||routeHandledRef.current)return;
    routeHandledRef.current=true;
    const search=window.location.search;
    const command=commandFromSearch(search);
    const route=routeFromSearch(search);

    if(command?.kind==="createCreation"){setEditing(null);setStudioStartSection("basics");setStudioOpen(true);return;}
    if(command?.kind==="editWorld"){
      // A world's own page sends its owner here to edit it, because the editor
      // lives in the shell alongside the studio rather than on its own route.
      setActiveView("worlds");
      void api<{world:World}>(`/api/worlds/${command.worldId}`).then(({world})=>setEditingWorld(world)).catch(()=>undefined);
      window.history.replaceState(window.history.state,"",viewHref("worlds"));
      return;
    }
    if(command?.kind==="editCreation"){
      // Editing has a real page of its own. Sending the reader there rather
      // than opening the studio on top of Home is what keeps Back returning to
      // wherever they pressed Edit.
      void api<{character:Character}>(`/api/characters/${command.characterId}`)
        .then(({character})=>router.replace(character.ownedByViewer?`/characters/${character.id}/edit`:`/characters/${character.id}`))
        .catch((reason)=>setError(reason instanceof Error?reason.message:"Could not open creation"));
      return;
    }

    if(!route)return;
    applyRoute(route);
    if(route.view==="chat"){
      // The creation page pushes `?character=…&conversation=…`. That is a real
      // chat, so it is canonicalised in place — same entry, same depth stamp,
      // now saying which story it is.
      const canonical=chatHref(route.characterId,route.conversationId);
      if(!isCurrentHref(window.location,canonical))window.history.replaceState(window.history.state,"",canonical);
      // The shell's own list may not hold this creation yet when it was opened
      // from somebody else's page.
      void api<{character:Character}>(`/api/characters/${route.characterId}`)
        .then(({character})=>setCharacters((items)=>items.some((item)=>item.id===character.id)?items:[character,...items]))
        .catch(()=>undefined);
    }
  },[authenticated,router,applyRoute]);
  /**
   * One request per open, and only the newest one is allowed to land.
   *
   * Keyed on the request's nonce rather than on the character id, so reopening
   * the same creation on a different story is a new request — which it plainly
   * is, and which an id comparison could not see.
   */
  useEffect(() => {
    if (!authenticated) { setChatView(clearChatView()); return; }
    const request = chatView.request;
    if (!request || !chatView.loading) return;
    const { characterId, conversationId, nonce } = request;
    loadChat(characterId, conversationId ?? undefined)
      .then((data) => {
        setChatView((view) => {
          if (!acceptsResponse(view, nonce)) return view;
          setConversations(data.conversations);
          return chatLoaded(view, nonce, data.conversation, data.messages);
        });
        loadMemories(characterId, data.conversation.id);
      })
      .catch((reason) => {
        setChatView((view) => {
          if (!acceptsResponse(view, nonce)) return view;
          setError(reason instanceof Error ? reason.message : "Could not open conversation");
          return chatFailed(view, nonce);
        });
      });
  }, [authenticated, chatView.request, chatView.loading, loadChat, loadMemories]);

  // A different story has a different set, so the previous one's count must
  // not survive the switch even for a frame.
  useEffect(() => { setStoryWorlds(null); }, [conversation?.id]);
  // Read it when the reader opens the tools or the story drawer, which is the
  // first moment the number is visible and therefore the first moment it is
  // worth a request. Never on the path into a story.
  useEffect(() => {
    const wanted = composerToolsOpen || storyNavigation.surface === "story" || storyNavigation.surface === "world";
    if (!wanted || !conversation || storyWorlds !== null) return;
    let live = true;
    void api<{ worlds: WorldSummary[] }>(`/api/conversations/${conversation.id}/worlds`)
      .then((data) => { if (live) setStoryWorlds(data.worlds); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [composerToolsOpen, storyNavigation.surface, conversation, storyWorlds]);

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
      if (regenerationTargetId && conversation) await refreshChat(conversation.characterId,conversation.id).catch(() => undefined);
      else setMessages((items) => items.filter((m) => m.id !== placeholderId));
      setError(e instanceof Error ? e.message : "The reply was interrupted");
    } finally { setStreaming(false); }
  }

  /**
   * Shows a conversation the server has just handed back in full.
   *
   * A created or branched story arrives complete — the row and its opening
   * message — so re-reading it over the network would be a second round trip
   * for something already in hand. Claiming a request token first is what stops
   * an older, still-in-flight load from landing on top of it.
   */
  const adoptConversation = useCallback((characterId: string, adopted: Conversation, adoptedMessages: Message[]) => {
    setSelectedId(characterId);
    setActiveView("chat");
    setChatView((view) => adoptChatView(view, characterId, adopted, adoptedMessages));
    setConversations((items) => [adopted, ...items.filter((item) => item.id !== adopted.id)]);
    setChatIndex((items) => [adopted, ...items.filter((item) => item.id !== adopted.id)]);
    setStoryNavigation(closedStoryNavigation);
    setMemories([]);
    const target = chatHref(characterId, adopted.id);
    if (!isCurrentHref(window.location, target)) router.push(target);
  }, [router]);

  /**
   * Starting another story with a creation.
   *
   * The pending flag is set before the request rather than after it, and the
   * drawer closes in the same tick. Previously the tap did nothing visible for
   * as long as the round trip took — the drawer stayed open, the button stayed
   * idle — and the new story appeared several seconds later, which read as a
   * dead click. The chat opens the instant the conversation has an id; nothing
   * waits on the library refresh behind it.
   */
  async function newConversation(greetingIndex = 0, personaId?: string | null) {
    if (!selected || streaming || creatingConversation) return;
    const character = selected;
    setCreatingConversation(true); setError("");
    setStoryNavigation(closedStoryNavigation);
    setChatNotice("Starting a new story…");
    try {
      const data = await api<{ conversation: Conversation; messages: Message[] }>("/api/conversations", { method: "POST", body: JSON.stringify({ characterId: character.id, greetingIndex, personaId: personaId ?? activePersona?.id ?? null }) });
      adoptConversation(character.id, data.conversation, data.messages);
      setChatNotice("New story ready");
      loadMemories(character.id,data.conversation.id);
    } catch (e) { setChatNotice(""); setError(e instanceof Error ? e.message : "Could not start a new chat"); }
    finally { setCreatingConversation(false); }
  }

  /** One conversation record, written to every list that holds a copy of it. */
  const applyConversation = useCallback((next: Conversation) => {
    setChatView((view) => view.conversation?.id === next.id ? { ...view, conversation: next } : view);
    setConversations((items) => items.map((item) => item.id === next.id ? next : item));
    setChatIndex((items) => items.map((item) => item.id === next.id ? next : item));
  }, []);

  /**
   * Changing something about this story.
   *
   * These are all low-risk preferences — response length, creativity, persona,
   * writer, instructions — and every one of them was previously invisible until
   * a full round trip finished: two network legs and six database round trips
   * before the word "Concise" appeared where "Natural" had been. That is the
   * two-second delay in the report, and it was never the reader's fault for
   * noticing.
   *
   * So the change is applied to the screen first and persisted behind it. This
   * function deliberately RESOLVES IMMEDIATELY, so the sheets that await it
   * close on the tap rather than on the response.
   *
   * A failure is not swallowed: the previous value is put back exactly, and the
   * reader is told. An optimistic update that cannot be undone would be worse
   * than the delay it replaced.
   */
  const updateConversationContext = useCallback(async (changes: Partial<Pick<Conversation,"personaId" | "providerId" | "modelId" | "rpEngineId" | "instructionPresets" | "customInstructions" | "responseLength" | "temperature">>) => {
    const previous = conversation;
    if (!previous) return;
    applyConversation({ ...previous, ...changes });
    setError("");
    void api<{ conversation: Conversation }>(`/api/conversations/${previous.id}`, { method: "PATCH", body: JSON.stringify(changes) })
      .then((data) => applyConversation(data.conversation))
      .catch((reason) => {
        applyConversation(previous);
        setError(reason instanceof Error ? reason.message : "Could not update this chat");
      });
  }, [conversation, applyConversation]);

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
            if (conversation) await refreshChat(conversation.characterId,conversation.id).catch(()=>undefined);
            setError(e instanceof Error?e.message:"Could not select that version");
            break;
          }
        }
        if (reloadAfterSave&&conversation) await refreshChat(conversation.characterId,conversation.id);
      } finally { variantWorkersRef.current.delete(message.id); }
    })();
  }

  async function branchFromMessage(message:Message) {
    if (!conversation||streaming||branchPendingRef.current) return;
    branchPendingRef.current=message.id; setBranchPendingMessageId(message.id); setError(""); setChatNotice("");
    const branchRequestId=crypto.randomUUID();
    try {
      const data=await api<{conversation:Conversation;messages:Message[]}>("/api/conversations",{method:"POST",body:JSON.stringify({branchFromConversationId:conversation.id,branchFromMessageId:message.id,branchRequestId})});
      adoptConversation(data.conversation.characterId,data.conversation,data.messages);
      loadMemories(data.conversation.characterId,data.conversation.id);
      setChatNotice("Branch created"); scrollToBottom();
    } catch(e) { setError(e instanceof Error?e.message:"Could not create a parallel story"); }
    finally { branchPendingRef.current=null; setBranchPendingMessageId(null); }
  }

  async function deleteFromMessage(message: Message, messagePosition: number) {
    if (!conversation || streaming || !window.confirm("Delete this message and everything after it?")) return;
    try {
      await api(`/api/messages/${message.id}`, { method: "DELETE", body: JSON.stringify({ messageId: message.id, conversationId: message.conversationId, messagePosition }) });
      await refreshChat(conversation.characterId, conversation.id);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete message"); }
  }

  /*
   * What the app shows while it is working out who is signed in.
   *
   * Route-aware, because "the app is opening" and "your story is opening" are
   * different truths and showing the wrong one is what made navigating into a
   * chat look like a trip through another section of the product. A URL that
   * names a chat boots into a chat-shaped skeleton; everything else keeps the
   * splash it has always had.
   */
  if (ageAccepted === null || authenticated === null) {
    return bootRoute?.view === "chat"
      ? <main className="app-shell booting"><ChatSkeletonPanel /></main>
      : <div className="splash"><Logo /><div className="pulse" /></div>;
  }
  if (!ageAccepted) return <AgeGate onAccept={() => { localStorage.setItem("afterglow_age_verified", "yes"); setAgeAccepted(true); }} />;
  if (!supabaseBrowserConfigured()) return <ConfigNotice />;
  if (!authenticated) return <AuthGate />;

  return (
    <ShellNavProvider value={shellNav}>
    <main className="app-shell">
      {accountNotice&&<div className="account-notice" role="status"><Sparkles size={14} aria-hidden />{accountNotice}<button onClick={()=>setAccountNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
      {/* The shell's own lists failing used to be reported only inside the chat
          panel, so a Chats page whose creations never arrived said nothing at
          all and stayed blank until the tab was reloaded. This banner belongs
          to the shell, so it is visible on whichever surface is open, and it
          offers the retry that the reader was previously performing with F5. */}
      {libraryError&&<div className="library-error" role="alert">
        <TriangleAlert size={16} aria-hidden />
        <div><strong>Some of your library could not be loaded.</strong><small>{libraryError}</small></div>
        <button onClick={()=>{setLibraryError("");refreshLibraries();}}>Try again</button>
      </div>}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Afterglow navigation">
        <div className="brand"><Logo /><button className="icon-button mobile-only" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={18} aria-hidden /></button></div>
        {/*
          * The main navigation.
          *
          * Redesigned rather than restructured: every destination the app had
          * is still here and still where it was in the order, because moving
          * somebody's Saved library to teach them a new information
          * architecture is not an improvement. What changed is that it now
          * looks like the rest of Afterglow —
          *
          *   ONE ICON FAMILY. It used to be nine text glyphs (⌂ ◫ ＋ ▤ ◉ ◎ ✎
          *   ❏ ≛) at whatever weight the font gave them, beside surfaces built
          *   entirely out of Lucide. They were the single most visible piece of
          *   the old product left in the new one.
          *
          *   THREE GROUPS, NAMED. Browse, Library and Account. Ten flat items
          *   is a list somebody reads every time; three groups of three or four
          *   is a shape they learn once.
          *
          *   ONE ACTIVE STATE, and it is unmistakable without being loud: a
          *   soft gradient panel and a warm accent rail, not a neon fill.
          *
          * Create keeps its place at the top as the one primary action, and it
          * is the only filled control in here.
          */}
        <button
          className="nav-create"
          onClick={() => { setStudioStartSection("basics"); setEditing(null); setStudioOpen(true); setSidebarOpen(false); }}
        >
          <Plus size={17} aria-hidden /><strong>Create</strong>
        </button>

        <nav className="primary-nav">
          {navSections.map((section) => <div key={section.id} className="nav-group">
            <span className="nav-group-label">{section.label}</span>
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = item.match(activeView);
              return <button
                key={item.id}
                className={active ? "active" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => item.open()}
              >
                <span className="nav-icon"><Icon size={17} aria-hidden /></span>
                <strong>{item.label}</strong>
                {/* The dot rides the nav item too, so somebody who is on a
                    surface with no header bell still learns there is
                    something waiting. Never colour alone: the count is in the
                    accessible name. */}
                {item.id === "notifications" && unreadNotifications > 0 && <>
                  <span className="nav-dot" aria-hidden />
                  <span className="nav-sr">{unreadLabel(unreadNotifications)} unread</span>
                </>}
              </button>;
            })}
          </div>)}
        </nav>
        <section className="sidebar-characters" aria-label="Your Creations"><button className="sidebar-section-link" onClick={()=>goToView("creations")}>Your Creations<ChevronRight size={12} aria-hidden /></button>{ownedCharacters.map((character)=><div className="sidebar-character" key={character.id}><button className="sidebar-character-link" title={`View ${creationTitle(character)}`} onClick={()=>openCharacterPage(character.id)}><Avatar character={character}/><strong>{creationTitle(character)}</strong></button><button className="sidebar-character-more" aria-label={`View or edit ${creationTitle(character)}`} aria-expanded={sidebarCharacterMenuId===character.id} onClick={()=>setSidebarCharacterMenuId((current)=>current===character.id?null:character.id)}><MoreHorizontal size={14} aria-hidden /></button>{sidebarCharacterMenuId===character.id&&<div className="sidebar-character-menu"><button aria-label={`View ${creationTitle(character)}`} onClick={()=>openCharacterPage(character.id)}>View creation</button><button aria-label={`Edit ${creationTitle(character)}`} onClick={()=>{setSidebarCharacterMenuId(null);setSidebarOpen(false);router.push(`/characters/${character.id}/edit`);}}>Edit creation</button></div>}</div>)}</section>
        <div className="sidebar-footer">
          {/* The account, as an identity rather than as a status pill: the same
              avatar and handle that appear on everything this account
              publishes, so the footer and the creator card agree. */}
          <button
            className="account-pill"
            onClick={() => openOwnProfile()}
            aria-label={profile?.username ? `Open your public creator profile, @${profile.username}` : "Edit your profile"}
          >
            <span className="account-avatar">
              {profileAvatar
                ? <img src={profileAvatar} alt="" />
                : <UserRound size={16} aria-hidden />}
            </span>
            <span className="account-copy">
              <strong>{profile?.displayName || activePersona?.name || "Your account"}</strong>
              <small>{profile?.username ? `@${profile.username}` : activePersona ? `Playing as ${activePersona.name}` : "Private library"}</small>
            </span>
          </button>
          <button
            className="sidebar-lock"
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => { await supabaseBrowser().auth.signOut(); forgetAllStoredDrafts(); clearUnreadNotifications(); setSidebarOpen(false); setAuthenticated(false); setProfile(null); }}
          ><LogOut size={16} aria-hidden /></button>
        </div>
      </aside>
      {/* The floating hamburger is gone. Every shell view now renders the one
          canonical menu control inside its own header, which is what removes
          the pair that appeared together on Worlds — and the stray one that
          rendered in normal flow above 760px because the old class was only
          ever declared inside two media queries. */}

      {activeView === "home" ? <DiscoveryFeed onOpenMenu={() => setSidebarOpen(true)} /> : activeView === "chats" ? <ChatsView characters={characters} conversations={chatIndex} personas={personas} onOpenMenu={() => setSidebarOpen(true)} onCreate={() => { setStudioStartSection("basics"); setEditing(null); setStudioOpen(true); }} onOpen={(characterId,conversationId) => openChat(characterId,conversationId)} /> : activeView === "worlds" ? <WorldsHub
        onOpenMenu={() => setSidebarOpen(true)}
        onCreate={() => setEditingWorld("new")}
        onEdit={(world) => setEditingWorld(world)}
        onChanged={() => void loadLibraries()}
      /> : activeView === "personas" ? <PersonasView personas={personas} onOpenMenu={() => setSidebarOpen(true)} onChange={() => void loadLibraries()} /> : activeView === "profile" ? <ProfileView profile={profile} onSaved={setProfile} onReturnToPublic={(username) => router.push(`/creators/${encodeURIComponent(username)}`)} onOpenMenu={() => setSidebarOpen(true)} /> : activeView === "saved" ? <LibraryView onOpenMenu={() => setSidebarOpen(true)} /> : activeView === "creations" ? <YourCreations
        onOpenMenu={() => setSidebarOpen(true)}
        onCreate={() => { setStudioStartSection("basics"); setEditing(null); setStudioOpen(true); }}
        onChanged={() => { void loadCharacters(); void loadChatIndex().catch(() => undefined); }}
      /> : activeView === "notifications" ? <NotificationsView onOpenMenu={() => setSidebarOpen(true)} />
        : activeView === "rankings" ? <RankingsView onOpenMenu={() => setSidebarOpen(true)} />
        : activeView === "reports" ? (isModerator?<AdminReports onOpenMenu={()=>setSidebarOpen(true)}/>:<DiscoveryFeed onOpenMenu={()=>setSidebarOpen(true)}/>)
        : selected ? (
        <section className="chat-panel">
          <header className="chat-header">
            <div className="chat-identity"><AppMenuButton className="chat-menu-button" onOpen={() => setSidebarOpen(true)} /><button className="identity-profile" title={`View ${creationTitle(selected)}`} onClick={() => openCharacterPage(selected.id)}><Avatar character={selected} large /><span><span className="eyebrow conversation-preview" title={conversation?.title}>{compactMessagePreview(conversation?.title || "Private conversation")}</span><strong>{creationTitle(selected)}</strong><small>{selected.creationType === "character" ? `Chatting as ${activePersona?.name || "You"}` : creationKindLine(selected)}</small></span></button></div>
            <div className="header-actions">
              <button className="icon-button labeled" onClick={() => setStoryNavigation(openStory())}><SlidersHorizontal size={16} aria-hidden /><span>Story</span></button>
              {isAdmin && <button className="icon-button labeled" onClick={() => setMemoryOpen(true)}><BrainCircuit size={16} aria-hidden /><span>Memories</span>{memories.length > 0 && <b>{memories.length}</b>}</button>}
              {selected.ownedByViewer?<button className="icon-button labeled" title={`Edit ${creationTitle(selected)}`} onClick={() => { setStudioStartSection("basics"); setEditing(selected); setStudioOpen(true); }}><Pencil size={16} aria-hidden /><span>Edit</span></button>:<button className="icon-button labeled" title={`View ${creationTitle(selected)}`} onClick={()=>openCharacterPage(selected.id)}><FileText size={16} aria-hidden /><span>Page</span></button>}
            </div>
          </header>
          <div className="messages" ref={attachMessageList} onScroll={trackScrollPosition}>
            {/* A story that is still arriving says so. The transcript of the
                PREVIOUS story is never what fills this space — it is cleared
                the moment another one is selected — so this skeleton is the
                only thing between one chat and the next. */}
            {chatView.loading&&!messages.length?<div className="chat-skeleton" aria-live="polite" aria-busy="true">
              <span className="sr-only">Loading this story</span>
              {[0,1,2].map((row)=><div key={row} className={`skeleton-message ${row%2?"":"skeleton-assistant"}`}><i /><i /><i /></div>)}
            </div>:<>
            <div className="date-divider"><span>THE STORY SO FAR</span></div>
            {messages.map((message, index) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" && <Avatar character={selected} />}
                <div className="message-stack">
                  <div className="message-meta"><strong>{message.role === "assistant" ? creationSubject(selected) : activePersona?.name || "You"}</strong><time>{time(message.createdAt)}</time></div>
                  <div className={`bubble ${!message.content && streaming ? "typing" : ""} ${editingMessageId === message.id ? "editing" : ""}`} style={editingMessageId === message.id && editWidth ? { width: editWidth } : undefined}>
                    {editingMessageId === message.id ? <div className="inline-editor"><textarea ref={editorRef} rows={1} autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditingMessageId(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMessageEdit(message,index + 1); } }} /><div><span>Esc to cancel · ⌘/Ctrl + Enter to save</span><button onClick={() => setEditingMessageId(null)}>Cancel</button><button className="save-edit" disabled={!editDraft.trim()} onClick={() => void saveMessageEdit(message,index + 1)}>Save</button></div></div> : <>{message.content ? (message.role === "assistant" && openingBlocks(message, index) ? <RichMessage blocks={openingBlocks(message, index)} bucket={characterAvatarBucket} /> : <StyledMessage content={message.content} providerEscapes={message.role === "assistant"} />) : <><i /><i /><i /></>}{message.role === "assistant" && message.content && message.variants.length > 1 && <div className="variant-picker"><button aria-label="Previous response option" disabled={streaming || message.selectedVariant === 0} onClick={() => void selectVariant(message,message.selectedVariant - 1,index + 1)}><ChevronLeft size={15} aria-hidden /></button><span>Option <strong>{message.selectedVariant + 1}</strong> of {message.variants.length}</span><button aria-label="Next response option" disabled={streaming || message.selectedVariant === message.variants.length - 1} onClick={() => void selectVariant(message,message.selectedVariant + 1,index + 1)}><ChevronRight size={15} aria-hidden /></button><em>Selected</em></div>}</>}
                  </div>
                  {message.content && editingMessageId !== message.id && <div className={`message-actions ${streaming ? "pending" : ""}`} aria-hidden={streaming}><button onClick={(e) => beginEdit(message, e.currentTarget.closest(".message-stack")?.querySelector(".bubble"))}><Pencil size={12} aria-hidden />Edit</button><button onClick={() => void deleteFromMessage(message,index + 1)}><Eraser size={12} aria-hidden />Delete from here</button>{message.role === "assistant" && <><button disabled={Boolean(branchPendingMessageId)} title="Create a separate story containing everything through this reply" onClick={() => void branchFromMessage(message)}>{branchPendingMessageId===message.id?<><LoaderCircle size={12} className="spin" aria-hidden />Creating…</>:<><GitBranch size={12} aria-hidden />Branch here</>}</button>{isAdmin && <button title="See which durable memories and historical arcs were recalled for this reply" onClick={() => setRecallMessage(message)}><BrainCircuit size={12} aria-hidden />{recallLabel(message)}</button>}{conversation && <MemoryFeedback messageId={message.id} conversationId={conversation.id} />}</>}{message.role === "assistant" && index === messages.length - 1 && <><button onClick={() => void send("regenerate")}><RefreshCw size={12} aria-hidden />Regenerate</button><button className="continue-action" title="Generate the character's next message" onClick={() => void send("continue")}><Play size={12} aria-hidden />Continue</button></>}</div>}
                </div>
              </article>
            ))}
            </>}
          </div>
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
          {chatNotice && <div className="success-banner" role="status"><Check size={14} aria-hidden /><strong>{chatNotice}</strong><button onClick={() => setChatNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button></div>}
          <div className="composer-wrap">
            {!atBottom && <button className="jump-latest" aria-label="Jump to the latest message" onClick={scrollToBottom}><ArrowDown size={13} aria-hidden />Latest</button>}
            <div className="mode-strip"><span className={selected.nsfwEnabled ? "adult-on" : ""}>{selected.nsfwEnabled ? "18+ adult mode" : "SFW mode"}</span><span aria-hidden>·</span><span>{activePersona?.name || "You"}</span>{conversation && activeInstructionCount(conversation) > 0 && <><span aria-hidden>·</span><span>{activeInstructionCount(conversation)} instructions</span></>}</div>
            {composerToolsOpen && <div className="composer-tools">
              <button onClick={() => openComposerTool("world")}><Globe2 size={16} aria-hidden /><strong>Worlds</strong><small>{storyWorlds===null?"In this story":storyWorlds.length===1?"1 in this story":`${storyWorlds.length} in this story`}</small></button>
              <button onClick={() => openComposerTool("persona")}><Users size={16} aria-hidden /><strong>Persona</strong><small>{activePersona?.name || "Choose who you are"}</small></button>
              <button onClick={() => openComposerTool("instructions")}><SlidersHorizontal size={16} aria-hidden /><strong>Instructions</strong><small>{instructionSummary(conversation)}</small></button>
              <button onClick={() => openComposerTool("model")}><Sparkles size={16} aria-hidden /><strong>Engine</strong><small>{modelCatalog.engines.find((engine)=>engine.id===(conversation?.rpEngineId||settings.roleplayPreset))?.label || "Choose an engine"}</small></button>
            </div>}
            <div className="composer">
              <IconButton className={`composer-plus ${composerToolsOpen ? "active" : ""}`} label={composerToolsOpen ? "Close chat tools" : "Open chat tools"} aria-expanded={composerToolsOpen} onClick={() => setComposerToolsOpen((value) => !value)}>{composerToolsOpen ? <X size={18} aria-hidden /> : <Plus size={18} aria-hidden />}</IconButton>
              <textarea ref={composerRef} value={composer} onChange={(e) => setComposer(e.target.value)} placeholder={`Message ${inlineTitle(creationSubject(selected), 24)}…`} rows={1} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !window.matchMedia("(max-width: 760px)").matches) { e.preventDefault(); void send(); } }} disabled={streaming} />
              <button className="send-button" aria-label="Send message" disabled={streaming || !composer.trim()} onClick={() => void send()}><ArrowUp size={18} aria-hidden /></button>
            </div>
            <small className="composer-hint"><span className="desktop-composer-hint">Enter to send · Shift + Enter for a new line</span><span className="mobile-composer-hint">Enter for a new line · Tap send to send</span></small>
          </div>
        </section>
      ) : chatView.request ? (
        /*
         * A story whose creation has not arrived yet.
         *
         * This branch used to render the studio's empty state — "Create
         * someone worth remembering" — because the only test was whether a
         * creation object was in hand. It is not in hand for the first moment
         * of every chat opened from somebody else's page, so tapping Chat
         * flashed an invitation to create a character. A pending chat request
         * is a chat that is loading, and it says so.
         */
        <ChatSkeletonPanel />
      ) : (
        <section className="empty-state"><div className="orb" aria-hidden>✦</div><span className="eyebrow">Your private story studio</span><h1>Create someone<br />worth remembering.</h1><p>Shape their history, voice, desires, and boundaries. Afterglow keeps the moments that matter.</p><button className="primary" onClick={() => setStudioOpen(true)}>Create your first character</button></section>
      )}

      {editingWorld && <WorldEditor
        world={editingWorld === "new" ? null : editingWorld}
        onClose={() => setEditingWorld(null)}
        onSaved={() => { setEditingWorld(null); void loadLibraries(); }}
        onDeleted={() => { setEditingWorld(null); void loadLibraries(); }}
      />}
      {studioOpen && <CreationStudio character={editing} worlds={worlds} startStep={studioStartSection} onLibrariesChanged={() => void loadLibraries()} onClose={() => { setStudioOpen(false); setEditing(null); }} onSaved={(character,{created}) => {
        setStudioOpen(false); setEditing(null);
        const destination=savedCreationDestination(character.id,{created,justCreatedParam});
        if(destination.kind==="creation"){
          /*
           * A brand-new creation lands on its own page, immediately and once.
           *
           * The three library refreshes below used to be AWAITED before this
           * navigation. The studio had already closed, so the reader was
           * looking at the feed while six requests finished, and then the
           * detail page opened by itself five to ten seconds later — the
           * "delayed surprise redirect". The refreshes are still wanted, but
           * they are background work and are no longer allowed to decide when
           * or whether anything navigates.
           *
           * The studio's entry is replaced rather than stacked on, and the
           * marker tells that page's Back control to go to Discovery instead
           * of back into the completed form.
           */
          claimDepth(window.sessionStorage,rootDepth);
          router.replace(destination.href);
          refreshLibraries();
          return;
        }
        openChat(character.id);
        refreshLibraries();
      }} onDeleted={() => { setStudioOpen(false); setEditing(null); goToView("chats"); void Promise.all([loadCharacters(),loadChatIndex()]).catch(()=>undefined); }} />}
      {isAdmin && memoryOpen && selected && <MemoryDrawer character={selected} conversation={conversation} memories={memories} onClose={() => setMemoryOpen(false)} onChange={async () => { const data = await api<{ memories: Memory[]; arcs: MemoryArc[] }>(memoriesUrl(selected.id,conversation?.id)); setMemories(data.memories); }} />}
      {storyNavigation.surface==="story" && selected && <ConversationDrawer character={selected} conversation={conversation} settings={settings} catalog={modelCatalog} personas={personas} conversations={conversations} activeId={conversation?.id ?? null} creating={creatingConversation} onClose={() => setStoryNavigation(closedStoryNavigation)} onNew={(greetingIndex,personaId) => void newConversation(greetingIndex,personaId)} onSelect={(id) => openChat(selected.id,id)} onChange={() => void refreshChat(selected.id)} onUpdate={updateConversationContext} onOpenModel={()=>setStoryNavigation(openStoryChild("model"))} onOpenPersona={()=>setStoryNavigation(openStoryChild("persona"))} onOpenInstructions={()=>setStoryNavigation(openStoryChild("instructions"))} onOpenWorld={()=>setStoryNavigation(openStoryChild("world"))} storyWorldCount={storyWorlds===null?null:storyWorlds.length} />}
      {settingsOpen && <SettingsSheet isAdmin={isAdmin} settings={settings} models={models} catalog={modelCatalog} onClose={() => setSettingsOpen(false)} onSaved={(value) => { setSettings({...defaultSettings,...value}); setSettingsOpen(false); }} onImported={async () => { await loadCharacters(); const data = await api<{ settings: AppSettings; catalog: ModelCatalog }>("/api/settings"); setSettings({...defaultSettings,...data.settings}); if(data.catalog)setModelCatalog(data.catalog); }} />}
      {isAdmin && recallMessage && <RecallDrawer message={recallMessage} onClose={() => setRecallMessage(null)} />}
      {storyNavigation.surface==="instructions" && conversation && <InstructionsSheet conversation={conversation} onClose={closeStoryNavigation} onSave={async (changes) => { await updateConversationContext(changes); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="persona" && conversation && <PersonaPicker personas={personas} selectedId={conversation.personaId || activePersona?.id || null} onClose={closeStoryNavigation} onManage={() => { setStoryNavigation(closedStoryNavigation); setActiveView("personas"); }} onCreated={(persona)=>setPersonas((items)=>[persona,...items])} onSave={async (personaId) => { await updateConversationContext({personaId}); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="model" && conversation && <ModelPicker catalog={modelCatalog} conversation={conversation} onClose={closeStoryNavigation} onSave={async (changes) => { await updateConversationContext(changes); closeStoryNavigation(); }} />}
      {storyNavigation.surface==="world" && conversation && <StoryWorldPicker conversationId={conversation.id} title={selected?creationTitle(selected):"this story"} onClose={closeStoryNavigation} onChanged={setStoryWorlds} />}
    </main>
    </ShellNavProvider>
  );
}

function Logo() { return <div className="logo"><span className="logo-mark">A</span><span>Afterglow</span></div>; }

/**
 * A chat that is opening.
 *
 * The same shape as the real thing — an identity row, a transcript, a composer
 * — so the surface a reader arrives on is the surface they asked for, in the
 * position it will occupy, rather than an unrelated section of the product
 * that happens to be what the shell defaults to. Used in three places: while
 * the session resolves on a chat URL, while the creation behind a chat is
 * still loading, and inside the panel while the transcript arrives.
 */
function ChatSkeletonPanel() {
  return <section className="chat-panel chat-panel-loading" aria-busy="true">
    <header className="chat-header">
      <div className="chat-identity">
        <div className="skeleton-avatar" aria-hidden />
        <div className="skeleton-identity" aria-hidden><i /><i /></div>
      </div>
    </header>
    <div className="messages">
      <div className="chat-skeleton" aria-live="polite">
        <span className="sr-only">Opening this story</span>
        {[0,1,2].map((row)=><div key={row} className={`skeleton-message ${row%2?"":"skeleton-assistant"}`}><i /><i /><i /></div>)}
      </div>
    </div>
    <div className="composer-wrap"><div className="composer skeleton-composer" aria-hidden /></div>
  </section>;
}

// Only the fields an avatar actually renders, so a draft preview does not
// have to fabricate public profile data to satisfy the type.
type AvatarSubject = Pick<Character, "name" | "accent" | "avatarUrl" | "avatarPath">;
function Avatar({ character, large = false }: { character: AvatarSubject; large?: boolean }) {
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
  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol" aria-hidden>◇</div>
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

  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol" aria-hidden>◇</div>
    <span className="eyebrow">{mode === "signup" ? "Create an account" : "Welcome back"}</span>
    <h1>{mode === "signup" ? "Begin your story." : "Sign in."}</h1>
    <p>{mode === "signup" ? "Your characters, chats, and memories stay private to your account." : "Your library is waiting exactly where you left it."}</p>
    <form onSubmit={submit}>
      {mode === "signup" && <input autoComplete="nickname" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />}
      <input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
      <input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      <button className="primary" disabled={busy || !email || password.length < 8}>{busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}</button>
      {error && <small className="form-error">{error}</small>}
      {notice && <div className="verification-notice"><Sparkles size={15} aria-hidden /><p>{notice}</p><button type="button" disabled={busy} onClick={()=>void resend()}>Resend email</button></div>}
    </form>
    <button className="text-button auth-switch" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); setNotice(""); }}>
      {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
    </button>
  </div></main>;
}

function AgeGate({ onAccept }: { onAccept: () => void }) {
  return <main className="gate"><div className="gate-card"><Logo /><div className="gate-symbol">18+</div><span className="eyebrow">Adults only</span><h1>Before you enter.</h1><p>This private instance can host mature fictional roleplay. You must be at least 18 and of legal age where you live.</p><button className="primary" onClick={onAccept}>I am an adult — continue</button><small>Afterglow prohibits sexual content involving minors, non-consensual exploitation, or real people.</small></div></main>;
}

type SceneStateDiagnostics = { enabled: boolean; current: SceneState | null; rendered: string; history: Array<{ state: SceneState; usable: boolean }> };

/** Administrator-only. Scene State is internal metadata and never shipped to a reader. */
function SceneStatePanel({ conversation }: { conversation: Conversation | null }) {
  const [scene, setScene] = useState<SceneStateDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!conversation) return;
    try { setScene(await api<SceneStateDiagnostics>(`/api/scene-state?conversationId=${conversation.id}`)); } catch { setScene(null); }
  }, [conversation]);
  useEffect(() => { void load(); }, [load]);
  if (!conversation || !scene) return null;
  const latest = scene.history[0]?.state ?? null;
  const current = scene.current;
  return <section className="summary-card"><span className="eyebrow">Current scene · this chat {scene.enabled ? "" : "· disabled"}</span>
    {scene.rendered ? <pre className="scene-state-block">{scene.rendered}</pre> : <p>No scene established yet. It fills in as the story states where, when, and who is present.</p>}
    {latest && <small>{latest.status === "failed" ? `Last update failed: ${latest.failureReason || "unknown error"}` : `Through message ${latest.throughMessageCount}${latest.provisional ? " (provisional)" : ""} · ${latest.extractionProvider || "—"}/${latest.extractionModel || "—"} · ${latest.extractionLatencyMs}ms · ${latest.tokenCount} tokens · updated ${new Date(latest.updatedAt).toLocaleString()}`}{current && latest !== current ? " · showing the last state still valid for this history" : ""}</small>}
    {scene.enabled && <button disabled={busy} onClick={async () => { setBusy(true); try { await api("/api/scene-state",{method:"POST",body:JSON.stringify({conversationId:conversation.id})}); await load(); } finally { setBusy(false); } }}>{busy ? "Reading scene…" : "Refresh scene"}</button>}
  </section>;
}

function MemoryDrawer({ character, conversation, memories, onClose, onChange }: { character: Character; conversation: Conversation | null; memories: Memory[]; onClose: () => void; onChange: () => void }) {
  const [content, setContent] = useState(""); const [keywords, setKeywords] = useState(""); const [scope,setScope] = useState<"chat"|"character">("chat"); const [busy, setBusy] = useState(false);
  async function updateMemory(memory: Memory, changes: Partial<Pick<Memory,"content"|"kind"|"importance"|"keywords"|"pinned"|"status"|"resolution">>) {
    await api(`/api/memories?id=${memory.id}`,{method:"PATCH",body:JSON.stringify({content:memory.content,kind:memory.kind,importance:memory.importance,keywords:memory.keywords,pinned:memory.pinned,status:memory.status,resolution:memory.resolution,...changes})});
    onChange();
  }
  const memoryKinds: SelectOption[] = [{value:"identity",label:"Identity"},{value:"relationship",label:"Relationship"},{value:"event",label:"Event"},{value:"promise",label:"Promise"},{value:"preference",label:"Preference"},{value:"boundary",label:"Boundary"},{value:"open_loop",label:"Open loop"}];
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}><aside className="memory-drawer"><header><div><span className="eyebrow">Continuity</span><h2>{character.name}&apos;s memories</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button></header><div className="memory-explainer"><BrainCircuit size={16} aria-hidden /><p>Generated memories belong only to this chat. Active promises and open loops receive protected recall; resolved ones remain in the permanent archive.</p>{conversation && <button disabled={busy || conversation.messageCount < 2} onClick={async () => { setBusy(true); try { await api("/api/memories/consolidate",{method:"POST",body:JSON.stringify({conversationId:conversation.id})}); onChange(); } finally { setBusy(false); } }}>{busy?"Remembering…":"Refresh now"}</button>}</div><SceneStatePanel conversation={conversation}/>{conversation?.summary && <section className="summary-card"><span className="eyebrow">Rolling story-so-far · this chat</span><p>{conversation.summary}</p></section>}<div className="memory-list">{memories.map((memory) => <article key={memory.id} className={`memory-card memory-${memory.status}`}><div><span className={`memory-pin ${memory.pinned ? "pinned" : ""}`}>{memory.pinned ? "◆ Pinned" : `Importance ${memory.importance}/5`} · {memory.conversationId ? "This chat" : "All chats"} · {memory.status}</span><span className="memory-controls"><SelectField label="Memory type" value={memory.kind} options={memoryKinds} onChange={(value)=>void updateMemory(memory,{kind:value as Memory["kind"]})} compact/>{(memory.kind === "promise" || memory.kind === "open_loop") && <SelectField label="Memory status" value={memory.status} options={[{value:"active",label:"Active"},{value:"resolved",label:"Resolved"},{value:"superseded",label:"Superseded"}]} onChange={(value)=>void updateMemory(memory,{status:value as Memory["status"],resolution:value === "active" ? "" : memory.resolution})} compact/>}<button onClick={() => void updateMemory(memory,{pinned:!memory.pinned})}>{memory.pinned?"Unpin":"Pin"}</button><button onClick={() => { const value=window.prompt("Edit memory",memory.content)?.trim(); if(value&&value!==memory.content) void updateMemory(memory,{content:value}); }}>Edit</button><button onClick={async () => { if(!window.confirm("Delete this memory?")) return; await api(`/api/memories?id=${memory.id}`, { method: "DELETE" }); onChange(); }}>Delete</button></span></div><p>{memory.content}</p>{memory.resolution && <p className="memory-resolution">Resolved: {memory.resolution}</p>}{memory.keywords.length > 0 && <small>{memory.keywords.map((key) => `#${key}`).join("  ")}</small>}</article>)}</div><form className="memory-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("/api/memories", { method: "POST", body: JSON.stringify({ characterId: character.id, conversationId: scope === "chat" ? conversation?.id ?? null : null, content, kind:"event", keywords: keywords.split(",").map((x) => x.trim()).filter(Boolean), importance: 5, pinned: true }) }); setContent(""); setKeywords(""); onChange(); } finally { setBusy(false); } }}><span className="eyebrow">Add pinned journal</span><SelectField label="Use in" value={scope} options={[{value:"chat",label:"This chat only"},{value:"character",label:"All chats with this character"}]} onChange={(value)=>setScope(value as "chat"|"character")}/><textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="A fact, promise, preference, or piece of lore…" rows={3} /><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="Recall keywords, comma separated" /><button className="primary" disabled={busy || !content.trim()}>Add to memory</button></form></aside></div>;
}

type RecallItem =
  | { kind: "memory"; id: string; available: true; content: string; memoryKind: string; status: string; importance: number; resolution: string; scope: "chat" | "creation" }
  | { kind: "arc"; id: string; available: true; summary: string; startMessageCount: number; endMessageCount: number }
  | { kind: "memory" | "arc"; id: string; available: false };
type RecallDetail = { items: RecallItem[]; counts: { memories: number; arcs: number; unavailable: number; total: number } };

/** "4 memories · 2 arcs", or "Context" when this reply recalled nothing. */
function recallLabel(message: Message) {
  const parts: string[] = [];
  if (message.memoryIds.length) parts.push(`${message.memoryIds.length} ${message.memoryIds.length === 1 ? "memory" : "memories"}`);
  if (message.arcIds.length) parts.push(`${message.arcIds.length} ${message.arcIds.length === 1 ? "arc" : "arcs"}`);
  return parts.length ? parts.join(" · ") : "Context";
}

/**
 * What one reply remembered.
 *
 * Reads the reply's own recall from the server rather than resolving its stored
 * ids against a list the shell loaded when the chat was opened. That list goes
 * stale the moment consolidation writes a new memory — which happens after
 * every reply — and resolving against it is how "Recalled 6" came to open an
 * empty panel. The count on the button and the rows in here are now the same
 * array, and an item that no longer exists says so instead of vanishing.
 */
function RecallDrawer({ message, onClose }: { message: Message; onClose: () => void }) {
  const [detail, setDetail] = useState<RecallDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<RecallDetail>(`/api/messages/${message.id}/recall`)
      .then((data) => { if (live) setDetail(data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [message.id]);

  const expected = message.memoryIds.length + message.arcIds.length;
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
    <aside className="memory-drawer recall-drawer">
      <header><div><span className="eyebrow">Reply context</span><h2>What this reply remembered</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button></header>
      <div className="memory-explainer"><BrainCircuit size={16} aria-hidden /><p>Every reply also receives the complete creation profile, the current rolling summary, and the recent transcript. Listed below are the {expected === 1 ? "one additional continuity item" : `${expected} additional continuity items`} recalled from the permanent archive for this reply.</p></div>
      <div className="memory-list">
        {!detail && !failed && <section className="summary-card"><span className="eyebrow">Reading this reply&apos;s recall</span></section>}
        {failed && <section className="summary-card"><span className="eyebrow">Recall unavailable</span><p>This reply&apos;s recall could not be read. Nothing has been lost — close and reopen this panel to try again.</p></section>}
        {detail?.items.map((item) => {
          if (!item.available) return <article className="memory-card memory-superseded" key={item.id}>
            <div><span className="memory-pin">{item.kind === "arc" ? "Historical arc" : "Memory"} · no longer in the archive</span></div>
            <p>This was recalled for the reply and has since been edited away or deleted. It is listed so the count above always matches what was used.</p>
          </article>;
          if (item.kind === "arc") return <article className="memory-card" key={item.id}>
            <div><span className="memory-pin">Historical arc · messages {item.startMessageCount}–{item.endMessageCount}</span></div>
            <p>{item.summary}</p>
          </article>;
          return <article className="memory-card" key={item.id}>
            <div><span className="memory-pin">{item.memoryKind.replace("_"," ")} · {item.status} · importance {item.importance}/5 · {item.scope === "chat" ? "this chat" : "all chats"}</span></div>
            <p>{item.content}</p>
            {item.resolution && <p className="memory-resolution">Resolution: {item.resolution}</p>}
          </article>;
        })}
        {detail && !detail.items.length && <section className="summary-card"><span className="eyebrow">No separate archive recall</span><p>Creation canon, rolling continuity and the recent transcript were still included. This reply drew nothing additional from the permanent archive.</p></section>}
      </div>
    </aside>
  </div>;
}

function ConversationDrawer({ character, conversation, settings, catalog, personas, conversations, activeId, creating, onClose, onNew, onSelect, onChange, onUpdate, onOpenModel, onOpenPersona, onOpenInstructions, onOpenWorld, storyWorldCount }: { character: Character; conversation: Conversation | null; settings: AppSettings; catalog: ModelCatalog; personas: Persona[]; conversations: Conversation[]; activeId: string | null; creating: boolean; onClose: () => void; onNew: (greetingIndex: number, personaId: string | null) => void; onSelect: (id: string) => void; onChange: () => void; onUpdate: (changes: Partial<Pick<Conversation,"responseLength"|"temperature">>) => Promise<void>; onOpenModel:()=>void; onOpenPersona:()=>void; onOpenInstructions:()=>void; onOpenWorld:()=>void; storyWorldCount:number|null }) {
  const [personaId,setPersonaId] = useState(personas.find((item) => item.isDefault)?.id ?? personas[0]?.id ?? "");
  const engine=catalog.engines.find((item)=>item.id===(conversation?.rpEngineId||settings.roleplayPreset));
  const activePersona=personas.find((item)=>item.id===conversation?.personaId)??personas.find((item)=>item.isDefault);
  const writer=catalog.models.find((item)=>item.id===conversation?.modelId);
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <aside className="memory-drawer conversation-drawer">
      <header>
        <div><span className="eyebrow">Story control center</span><h2>{character.name}</h2></div>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button>
      </header>

      {conversation && <section className="story-controls">
        <div className="story-control-grid">
          <SettingsChoiceRow icon={<Sparkles size={16} />} label="Engine" value={engine?.label || conversation.rpEngineId} onClick={onOpenModel} />
          <SettingsChoiceRow icon={<BrainCircuit size={16} />} label="Writer model" value={writer?.label || conversation.modelId} onClick={onOpenModel} />
          <SettingsChoiceRow icon={<Users size={16} />} label="Persona" value={activePersona?.name || "Choose who you are"} onClick={onOpenPersona} />
          <SelectField
            row
            icon={<FileText size={16} />}
            label="Response length"
            value={conversation.responseLength || "default"}
            onChange={(value) => void onUpdate({ responseLength: value === "default" ? null : value as Conversation["responseLength"] })}
            options={[
              { value: "default", label: `Use default (${settings.responseLength})` },
              { value: "concise", label: "Concise", description: "Tighter replies with fewer beats." },
              { value: "natural", label: "Natural", description: "Preserves Afterglow's current pacing." },
              { value: "detailed", label: "Detailed", description: "Fuller scenes where the moment supports it." },
            ]}
          />
          <SettingsChoiceRow icon={<SlidersHorizontal size={16} />} label="Instructions" value={instructionSummary(conversation)} onClick={onOpenInstructions} />
          <SettingsChoiceRow
            icon={<Globe2 size={16} />}
            label="Worlds"
            value={storyWorldCount === null ? "In this story" : storyWorldCount === 1 ? "1 in this story" : `${storyWorldCount} in this story`}
            onClick={onOpenWorld}
          />
          <SelectField
            row
            icon={<Gauge size={16} />}
            label="Creativity"
            value={conversation.temperature == null ? "default" : String(conversation.temperature)}
            onChange={(value) => void onUpdate({ temperature: value === "default" ? null : Number(value) })}
            options={[
              { value: "default", label: `Use default (${settings.temperature})` },
              { value: "0.7", label: "Grounded" },
              { value: "0.95", label: "Balanced" },
              { value: "1.15", label: "Expressive" },
            ]}
          />
        </div>
        <p className="setting-note">These choices affect only this story. Messages, branches, and continuity stay intact.</p>
      </section>}

      <div className="drawer-action">
        <span className="field-label">Start another story as</span>
        <div className="persona-choice-grid">{personas.map((persona)=><button key={persona.id} className={personaId===persona.id?"selected":""} onClick={()=>setPersonaId(persona.id)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available persona"}</small></span></button>)}</div>
        <button className="primary" disabled={creating} onClick={() => onNew(0,personaId || null)}>{creating?<><LoaderCircle size={15} className="spin" aria-hidden />Starting…</>:<><Plus size={15} aria-hidden />Start separate story</>}</button>
        <p>Opening messages appear as options on the first reply. Existing stories are never reset.</p>
      </div>
      <div className="conversation-list">{conversations.map((item) => <article key={item.id} className={`conversation-card ${item.id === activeId ? "active" : ""}`}><button className="conversation-main" onClick={() => onSelect(item.id)}><strong>{item.title}</strong><span>{item.messageCount} messages · {personas.find((persona) => persona.id === item.personaId)?.name || "Default persona"} · {new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(new Date(item.updatedAt))}</span></button><div><button title="Rename" onClick={async () => { const title = window.prompt("Conversation title",item.title)?.trim(); if (!title || title === item.title) return; await api(`/api/conversations/${item.id}`,{method:"PATCH",body:JSON.stringify({title})}); onChange(); }}><Pencil size={14} aria-hidden /></button><button title="Delete" onClick={async () => { if (!window.confirm(`Delete “${item.title}” and its chat-specific memories? All-chats journal entries will remain.`)) return; await api(`/api/conversations/${item.id}`,{method:"DELETE"}); onChange(); }}><Trash2 size={14} aria-hidden /></button></div></article>)}</div>
    </aside>
  </div>;
}

/**
 * The worlds THIS STORY is written with.
 *
 * The picker this replaces read `character.worldIds`, and saved by sending the
 * whole creation back through `PATCH /api/characters/{id}`. Two things were
 * wrong with that and they were the same thing twice: a reader attaching a
 * world to their own story attached it to the CREATION — so it appeared in the
 * creator's studio, on the public creation page, and in every other reader's
 * prompt — and only a creation's owner could do it at all, because only an
 * owner may write that endpoint.
 *
 * A story owns its world set now. Attaching and detaching write one row of
 * `conversation_worlds`, take effect on the next reply, and are invisible to
 * the Creation and to everybody else. Everyone with a story can use this, not
 * only creators, and the copy says which of the two things is being changed
 * because that ambiguity is what the sprint reported.
 */
function StoryWorldPicker({conversationId,title,onClose,onChanged}:{conversationId:string;title:string;onClose:()=>void;onChanged:(worlds:WorldSummary[])=>void}) {
  const [attached,setAttached]=useState<WorldSummary[]|null>(null);
  const [available,setAvailable]=useState<WorldSummary[]>([]);
  const [busyId,setBusyId]=useState("");
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");

  useEffect(()=>{
    let live=true;
    api<{worlds:WorldSummary[];available:WorldSummary[]}>(`/api/conversations/${conversationId}/worlds`)
      .then((data)=>{ if(!live)return; setAttached(data.worlds); setAvailable(data.available); })
      .catch((reason)=>{ if(live)setError(reason instanceof Error?reason.message:"Could not read this story's worlds"); });
    return()=>{live=false;};
  },[conversationId]);

  const attachedIds=new Set((attached??[]).map((world)=>world.id));
  const normalized=query.trim().toLowerCase();
  const candidates=available
    .filter((world)=>!attachedIds.has(world.id))
    .filter((world)=>!normalized||world.name.toLowerCase().includes(normalized)||world.description.toLowerCase().includes(normalized));

  /** One attach or detach. The list the server returns is the truth. */
  async function change(world:WorldSummary,attach:boolean){
    setBusyId(world.id); setError("");
    try{
      const data=attach
        ? await api<{worlds:WorldSummary[]}>(`/api/conversations/${conversationId}/worlds`,{method:"POST",body:JSON.stringify({worldId:world.id})})
        : await api<{worlds:WorldSummary[]}>(`/api/conversations/${conversationId}/worlds?worldId=${world.id}`,{method:"DELETE"});
      setAttached(data.worlds);
      onChanged(data.worlds);
    }catch(reason){ setError(reason instanceof Error?reason.message:"Could not change this story's worlds"); }
    finally{ setBusyId(""); }
  }

  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)onClose();}}>
    <aside className="memory-drawer picker-drawer">
      <header>
        <div><span className="eyebrow">This story only</span><h2>Worlds in {inlineTitle(title,28)}</h2></div>
        <button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button>
      </header>
      <div className="picker-body">
        <p>These worlds are canon for <strong>this story</strong>. Adding or removing one here changes what the writer reads in this conversation and nothing else — the creation itself, its other stories, and anybody else&apos;s stories are untouched.</p>
        {error&&<p className="picker-error" role="alert">{error}</p>}

        <div className="picker-group">
          <span className="field-label">In this story{attached?` · ${attached.length}`:""}</span>
          {attached===null&&<p className="picker-quiet">Reading this story&apos;s worlds…</p>}
          {attached?.length===0&&<p className="picker-quiet">No worlds in this story. Anything you add below applies from the next reply.</p>}
          {attached?.map((world)=><label key={world.id} className="picker-row">
            <span><strong>{world.name}</strong>{world.description&&<small>{world.description}</small>}</span>
            <button type="button" disabled={busyId===world.id} aria-label={`Remove ${world.name} from this story`} onClick={()=>void change(world,false)}>
              {busyId===world.id?"…":"Remove"}
            </button>
          </label>)}
        </div>

        <div className="picker-group">
          <span className="field-label">Add to this story</span>
          {available.length>6&&<input
            className="picker-search"
            value={query}
            placeholder="Search your worlds…"
            aria-label="Search worlds"
            onChange={(event)=>setQuery(event.target.value)}
          />}
          {candidates.length===0&&<p className="picker-quiet">{available.length?"Nothing else to add.":"You have no worlds yet. Create one from the Worlds page and it will be available here."}</p>}
          {candidates.map((world)=><label key={world.id} className="picker-row">
            <span><strong>{world.name}</strong>{world.description&&<small>{world.description}</small>}</span>
            <button type="button" disabled={busyId===world.id} aria-label={`Add ${world.name} to this story`} onClick={()=>void change(world,true)}>
              {busyId===world.id?"…":"Add"}
            </button>
          </label>)}
        </div>
      </div>
      <footer className="picker-footer"><button className="primary" onClick={onClose}>Done</button></footer>
    </aside>
  </div>;
}

function PersonaAvatar({ persona }: { persona: Persona }) { const source = avatarSource(profileAvatarBucket, persona.avatarPath, persona.avatarUrl); return <div className="persona-preview" style={{"--accent":persona.accent} as React.CSSProperties}>{source?<img src={source} alt=""/>:<span>{initials(persona.name)}</span>}</div>; }

function PersonaPicker({ personas, selectedId, onClose, onManage, onCreated, onSave }: { personas: Persona[]; selectedId: string | null; onClose: () => void; onManage: () => void; onCreated:(persona:Persona)=>void; onSave: (personaId: string | null) => Promise<void> }) {
  const [pending,setPending] = useState<string|null>(selectedId); const [busy,setBusy] = useState(false); const [creating,setCreating]=useState(false); const [name,setName]=useState(""); const [description,setDescription]=useState(""); const [error,setError]=useState("");
  async function create(){setBusy(true);setError("");try{const data=await api<{persona:Persona}>("/api/personas",{method:"POST",body:JSON.stringify({name,description,avatarUrl:"",avatarPath:"",accent:"#e879a9",isDefault:personas.length===0})});onCreated(data.persona);setPending(data.persona.id);setCreating(false);}catch(e){setError(e instanceof Error?e.message:"Could not create persona");}finally{setBusy(false);}}
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)onClose();}}><aside className="memory-drawer picker-drawer persona-picker"><header><div><span className="eyebrow">This story</span><h2>Choose persona</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button></header><div className="picker-body"><p>Choose who you are in this chat. Changing persona does not reset its messages or memories.</p><div className="persona-picker-list">{personas.map((persona)=><button key={persona.id} className={pending===persona.id?"selected":""} onClick={()=>setPending(persona.id)}><PersonaAvatar persona={persona}/><span><strong>{persona.name}</strong><small>{persona.isDefault?"Default persona":"Available for any chat"}</small><p>{compactMessagePreview(persona.description||"No profile details yet.",150)}</p></span><b>{pending===persona.id?"✓":""}</b></button>)}</div>{creating?<div className="inline-create"><label>Persona name<input autoFocus value={name} onChange={(e)=>setName(e.target.value)}/></label><label>What should characters know?<textarea rows={6} value={description} onChange={(e)=>setDescription(e.target.value)}/></label><div><button className="secondary" onClick={()=>setCreating(false)}>Cancel</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void create()}>{busy?"Creating…":"Create persona"}</button></div></div>:<div className="picker-create-actions"><button className="secondary create-from-picker" onClick={()=>setCreating(true)}><Plus size={15} aria-hidden />Create persona</button><button className="secondary create-from-picker" onClick={onManage}><Pencil size={15} aria-hidden />Manage</button></div>}{!personas.length&&!creating&&<div className="empty-library-note">Create your first persona to tell characters who they are speaking with.</div>}{error&&<div className="form-error">{error}</div>}</div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!pending} onClick={async()=>{setBusy(true);try{await onSave(pending);}finally{setBusy(false);}}}>{busy?"Saving…":"Use persona"}</button></footer></aside></div>;
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
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event)=>{if(event.currentTarget===event.target)onClose();}}><aside className="memory-drawer picker-drawer model-picker"><header><div><span className="eyebrow">How this story is written</span><h2>Roleplay engine</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button></header><div className="picker-body"><p>The engine decides how the roleplay is handled — pacing, escalation, initiative, how much the cast is kept apart. Your creation stays the character it is, and your world, persona, history and memory are unchanged when you switch.</p><div className={`model-navigation ${searchOpen?"searching":""}`}>{searchOpen?<><input autoFocus value={search} onChange={(event)=>setSearch(event.target.value)} placeholder="Search engines" aria-label="Search engines"/><button className="icon-button" aria-label="Close search" onClick={()=>{setSearchOpen(false);setSearch("");}}><X size={16} aria-hidden /></button></>:<><button className={section==="discover"?"active":""} onClick={()=>setSection("discover")}>Discover</button><button className={section==="favorites"?"active":""} onClick={()=>setSection("favorites")}>Favorites</button><button className="model-search-button" aria-label="Search engines" onClick={()=>setSearchOpen(true)}><Search size={15} aria-hidden /></button></>}</div><div className="model-card-list">{engines.map((engine)=><article key={engine.id} className={engine.id===engineId?"model-card selected":"model-card"}><button className="model-card-main" onClick={()=>setEngineId(engine.id)}><span className="model-radio">{engine.id===engineId?"●":"○"}</span><span><strong>{engine.label}</strong><small>{engine.description}</small><span className="model-tags">{engine.adult&&<em>18+ RP</em>}{engine.tags.map((tag)=><i key={tag}>{tag}</i>)}</span></span></button><button className={favorites.includes(engine.id)?"model-favorite active":"model-favorite"} aria-label={favorites.includes(engine.id)?`Remove ${engine.label} from favourites`:`Favourite ${engine.label}`} onClick={()=>toggleFavorite(engine.id)}><Star size={15} fill={favorites.includes(engine.id)?"currentColor":"none"} aria-hidden /></button></article>)}</div>{!engines.length&&<div className="empty-library-note">{searchOpen?"No engines match that search.":"Favourite an engine in Discover and it will appear here."}</div>}<button className="advanced-model-toggle" onClick={()=>setAdvanced((value)=>!value)}><span><strong>Writer model</strong><small>{selectedModel?.label||conversation.modelId}</small></span><b><ChevronDown size={15} className={advanced?"flip":""} aria-hidden /></b></button>{advanced&&<div className="advanced-model-panel"><p>The engine above is Afterglow&apos;s brief for how to write. The writer model is the language model that writes to it — a different capability, not a different style.</p><SelectField label="Provider" value={providerId} onChange={(value)=>{setProviderId(value);setModelId(catalog.models.find((model)=>model.providerId===value)?.id||"");}} options={catalog.providers.map((provider)=>({value:provider.id,label:provider.label}))}/><SelectField label="Writer model" value={modelId} onChange={setModelId} options={models.map((model)=>({value:model.id,label:model.label,description:model.description}))}/></div>}</div><footer className="drawer-footer"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy||!selectedModel} onClick={async()=>{if(!selectedModel)return;setBusy(true);try{await onSave({providerId,modelId:selectedModel.id,rpEngineId:engineId});}finally{setBusy(false);}}}>{busy?"Switching…":"Use engine"}</button></footer></aside></div>;
}

/**
 * Optional public-profile enrichment.
 *
 * Everything here can be left empty: the public page hides a section it has no
 * data for rather than showing a placeholder, so a casual creator is never
 * pushed through a long form to get a working character.
 */
