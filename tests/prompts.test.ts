import { describe, expect, it } from "vitest";
import { continueSceneCue, roleplayPrompt } from "@/lib/prompts";
import type { Character } from "@/lib/types";

const character: Character = {
  id: "1", name: "Mara", creationType: "character", title: "", profileType: "single", tagline: "Art thief",
  description: "", descriptionRich: [], greetingRich: [], alternateGreetingsRich: [], userRole: "", avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: "Mara is 31.", cast: [], lorebook: "Paris factions.", personality: "Dry wit.", scenario: "Paris.", greeting: "Hello.", alternateGreetings: [],
  exampleDialogue: "A sample.", responseDirective: "Be vivid.", boundaries: "Respect stop words.",
  sourceMaterial: "", worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "private", ownedByViewer: true, nsfwEnabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

/**
 * A scenario-led creation: no primary character, a defined user role, and the
 * AI responsible for narration and every NPC.
 */
const scenario: Character = {
  ...character,
  name: "The Final War",
  creationType: "scenario",
  title: "The Final War",
  profileType: "ensemble",
  userRole: "A sealed asset whose file is classified.",
  scenario: "U.A. is a fortress now.",
  personality: "Grim, procedural, exhausted.",
  responseDirective: "Narrate the world and every NPC.",
  cast: [],
};

describe("roleplay prompt", () => {
  it("includes continuity and adult-only safety boundaries", () => {
    const prompt = roleplayPrompt(character, "They made a promise.", []);
    expect(prompt).toContain("They made a promise.");
    expect(prompt).toContain("fictional adult aged 21 or older");
    expect(prompt).toContain("Never write the user's dialogue");
    expect(prompt).toContain("independent motives");
    expect(prompt).toContain("Do not merely restate");
    expect(prompt).toContain("CURRENT CONTINUITY");
    expect(prompt).toContain("Initial scenario / premise");
    expect(prompt).toContain("LOREBOOK / WORLD CANON");
    expect(prompt).toContain("Never reset a developed relationship");
    expect(prompt).toContain("Do not invent an offscreen move");
  });

  it("supports a direct but autonomous adult roleplay preset", () => {
    const prompt = roleplayPrompt(character, "", [], [], { ownerName:"Alex", ownerProfile:"", roleplayPreset:"raw" });
    expect(prompt).toContain("RAW ADULT");
    expect(prompt).toContain("do not sanitize");
    expect(prompt).toContain("they are not wish-fulfillment puppets");
    expect(prompt).toContain("initiate, hesitate, negotiate, refuse, stop, or leave");
  });

  it("injects only the selected persona, attached worlds, and chat instructions", () => {
    const prompt = roleplayPrompt(character,"",[],[],{ownerName:"Fallback",ownerProfile:"",roleplayPreset:"immersive"},{
      persona:{id:"persona",name:"Alex",description:"A private detective",avatarUrl:"",avatarPath:"",accent:"#e879a9",isDefault:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},
      worlds:[{id:"world",name:"Paris Underground",description:"Secret city",content:"The Glass Guild controls the tunnels.",contentRich:[],coverPath:"",coverUrl:"",visibility:"private",saveCount:0,savedByViewer:false,ownedByViewer:true,creator:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}],
      instructionPresets:["reduce_repetition"], customInstructions:"Use clipped dialogue.",
    });
    expect(prompt).toContain("Name: Alex");
    expect(prompt).toContain("Paris Underground");
    expect(prompt).toContain("Actively avoid repeating");
    expect(prompt).toContain("Use clipped dialogue.");
    expect(prompt.indexOf("CHARACTER")).toBeLessThan(prompt.indexOf("CURRENT CONTINUITY — DYNAMIC"));
    expect(prompt.indexOf("CHAT-SPECIFIC INSTRUCTIONS")).toBeLessThan(prompt.indexOf("CURRENT CONTINUITY — DYNAMIC"));
  });

  it("runs a scenario as narrator rather than as a fabricated primary character", () => {
    const prompt = roleplayPrompt(scenario, "", []);
    expect(prompt).toContain('You run the roleplay experience "The Final War"');
    expect(prompt).toContain("SCENARIO");
    expect(prompt).toContain("Premise / what is happening: U.A. is a fortress now.");
    expect(prompt).toContain("Tone, atmosphere and narrative style: Grim, procedural, exhausted.");
    expect(prompt).toContain("THE USER'S ROLE IN THIS STORY");
    expect(prompt).toContain("A sealed asset whose file is classified.");
    // With no cast defined the model is told to improvise, never handed an
    // empty character sheet to fill in.
    expect(prompt).toContain("IMPORTANT CHARACTERS");
    expect(prompt).toContain("No individually defined characters");
    expect(prompt).not.toContain("Card name:");
  });

  it("keeps the character prompt unchanged for a single character", () => {
    const prompt = roleplayPrompt(character, "", []);
    expect(prompt).toContain("You are Mara and portray the living world around them");
    expect(prompt).toContain("Card name: Mara");
    expect(prompt).not.toContain("THE USER'S ROLE IN THIS STORY");
  });

  it("continues the scene without inventing a user turn", () => {
    expect(continueSceneCue).toContain("control signal, not dialogue from the user");
    expect(continueSceneCue).toContain("Do not write the user's dialogue");
    expect(continueSceneCue).toContain("Do not repeat or paraphrase");
  });

  it("keeps natural unchanged and gives concise and detailed concrete written targets", () => {
    const natural=roleplayPrompt(character,"",[],[],{ownerName:"Alex",ownerProfile:"",roleplayPreset:"immersive",responseLength:"natural"});
    const concise=roleplayPrompt(character,"",[],[],{ownerName:"Alex",ownerProfile:"",roleplayPreset:"immersive",responseLength:"concise"});
    const detailed=roleplayPrompt(character,"",[],[],{ownerName:"Alex",ownerProfile:"",roleplayPreset:"immersive",responseLength:"detailed"});
    // Natural is the untouched baseline: it must add nothing at all.
    expect(natural).not.toContain("RESPONSE LENGTH");
    // The other two are requirements with a shape and a number, not adjectives.
    expect(concise).toContain("RESPONSE LENGTH — CONCISE (ACTIVE REQUIREMENT)");
    expect(concise).toContain("ONE to TWO short paragraphs");
    expect(concise).toMatch(/roughly \d+-\d+ words/);
    expect(detailed).toContain("RESPONSE LENGTH — DETAILED (ACTIVE REQUIREMENT)");
    expect(detailed).toContain("THREE to FIVE paragraphs");
    expect(detailed).toContain("Do not pad");
    // Neither mode may ever ask for a cut-off reply.
    expect(concise).toContain("end on a whole sentence");
    expect(detailed).toContain("End on a whole sentence");
  });
});
