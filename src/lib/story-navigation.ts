export type StoryChild = "model" | "instructions" | "persona" | "world";
export type StoryNavigationState = {
  surface: "closed" | "story" | StoryChild;
  parent: "chat" | "story";
};

export const closedStoryNavigation: StoryNavigationState = { surface: "closed", parent: "chat" };

export function openStory(): StoryNavigationState {
  return { surface: "story", parent: "chat" };
}

export function openStoryChild(child: StoryChild): StoryNavigationState {
  return { surface: child, parent: "story" };
}

export function openChatChild(child: StoryChild): StoryNavigationState {
  return { surface: child, parent: "chat" };
}

export function closeStorySurface(state: StoryNavigationState): StoryNavigationState {
  return state.parent === "story" && state.surface !== "story"
    ? { surface: "story", parent: "chat" }
    : closedStoryNavigation;
}
