"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import type { Character, World } from "@/lib/types";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import styles from "./profile.module.css";

type Detail={character:Character;worlds:World[];viewerMessageCount:number;owner:boolean};
const sections=[{id:"overview",label:"Overview",icon:"▣"},{id:"highlights",label:"Highlights",icon:"✧"},{id:"world",label:"World",icon:"◎"},{id:"gallery",label:"Gallery",icon:"▧"},{id:"comments",label:"Comments",icon:"☆"}];

function compact(value:number){return new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(value);}
function initials(name:string){return name.split(/\s+/).map((part)=>part[0]).join("").slice(0,2).toUpperCase()||"?";}

export default function CharacterProfile({characterId}:{characterId:string}) {
  const router=useRouter();
  const [detail,setDetail]=useState<Detail|null>(null);
  const [error,setError]=useState("");
  const [active,setActive]=useState("overview");
  const [pulse,setPulse]=useState("");
  const [starting,setStarting]=useState(false);

  useEffect(()=>{fetch(`/api/characters/${characterId}`).then(async(response)=>{const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"Could not open this character");setDetail(body);}).catch((reason)=>setError(reason instanceof Error?reason.message:"Could not open this character"));},[characterId]);
  useEffect(()=>{
    const observer=new IntersectionObserver((entries)=>{const visible=entries.filter((entry)=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(visible)setActive(visible.target.id);},{rootMargin:"-24% 0px -62%",threshold:[0,.2,.6]});
    sections.forEach(({id})=>{const node=document.getElementById(id);if(node)observer.observe(node);});
    return ()=>observer.disconnect();
  },[detail]);

  const image=useMemo(()=>detail?avatarSource(characterAvatarBucket,detail.character.avatarPath,detail.character.avatarUrl):"",[detail]);
  if(error)return <main className={styles.state}><span>✦</span><h1>Character unavailable</h1><p>{error}</p><Link href="/">Return to Afterglow</Link></main>;
  if(!detail)return <main className={styles.state}><span className={styles.spinner}>✦</span><h1>Opening character</h1></main>;
  const {character,worlds,viewerMessageCount,owner}=detail;
  const creator=character.creator?.displayName||character.creator?.username||"Private creator";
  const created=new Intl.DateTimeFormat(undefined,{month:"short",year:"numeric"}).format(new Date(character.createdAt));
  const openings=(character.greeting?1:0)+character.alternateGreetings.length;
  const navigate=(id:string)=>{document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"start"});setPulse(id);window.setTimeout(()=>setPulse(""),650);};
  const start=async()=>{setStarting(true);try{const response=await fetch("/api/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({characterId})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"Could not start chat");router.push(`/?character=${characterId}&conversation=${body.conversation.id}`);}catch(reason){setError(reason instanceof Error?reason.message:"Could not start chat");setStarting(false);}};
  const toggleLike=async()=>{const method=character.likedByViewer?"DELETE":"POST";const url=method==="DELETE"?`/api/likes?characterId=${character.id}`:"/api/likes";const response=await fetch(url,{method,headers:{"Content-Type":"application/json"},...(method==="POST"?{body:JSON.stringify({characterId:character.id})}:{})});if(response.ok)setDetail((current)=>current?{...current,character:{...current.character,likedByViewer:!current.character.likedByViewer,likeCount:Math.max(0,(current.character.likeCount||0)+(current.character.likedByViewer?-1:1))}}:current);};

  return <main className={styles.page} style={{"--character-accent":character.accent} as React.CSSProperties}>
    <aside className={styles.rail} aria-label="Afterglow navigation"><Link className={styles.brand} href="/" aria-label="Afterglow">✦<span>afterglow</span></Link><nav><Link href="/?view=home"><span>⌂</span>Home</Link><Link href="/?view=chats"><span>▢</span>Chats</Link><Link href="/?create=1"><span>＋</span>Create</Link><Link href="/?view=worlds"><span>◫</span>Worlds</Link><Link href="/?view=personas"><span>♙</span>Personas</Link><Link href="/?view=profile"><span>○</span>Profile</Link></nav></aside>
    <div className={styles.content}>
      <section className={styles.hero}>
        <div className={styles.heroImage} style={image?{backgroundImage:`url(${JSON.stringify(image)})`}:undefined}>{!image&&<span>{initials(character.name)}</span>}</div>
        <div className={styles.mobileTop}><Link href="/" aria-label="Back">‹</Link><div><button aria-label="Share character" onClick={()=>void navigator.share?.({title:character.name,url:location.href})}>⌯</button>{!owner&&<button aria-label={character.likedByViewer?"Unlike":"Like"} onClick={()=>void toggleLike()}>{character.likedByViewer?"♥":"♡"}</button>}</div></div>
        <div className={styles.heroActions}>{!owner&&<button onClick={()=>void toggleLike()}>{character.likedByViewer?"♥":"♡"} {compact(character.likeCount||0)}</button>}<button aria-label="Share character" onClick={()=>void navigator.share?.({title:character.name,url:location.href})}>⌯</button>{owner&&<Link href={`/characters/${character.id}/edit`}>✎</Link>}</div>
        <div className={styles.heroCopy}>
          <span className={styles.kicker}>{character.profileType==="ensemble"?"Ensemble character":"Afterglow character"}</span>
          <h1>{character.name}<i>✦</i></h1>
          <p className={styles.tagline}>{character.tagline||"A character waiting for the story to begin."}</p>
          <div className={styles.realTags}>{character.nsfwEnabled&&<span>18+</span>}{worlds.slice(0,2).map((world)=><span key={world.id}>{world.name}</span>)}</div>
          <p className={styles.byline}><strong>{creator}</strong><span>·</span><span>{viewerMessageCount?`${compact(viewerMessageCount)} of your messages`:"No messages from you yet"}</span><span>·</span><span>Created {created}</span></p>
          <div className={styles.ctas}><button onClick={()=>void start()} disabled={starting}>✦ {starting?"Opening story…":`Chat with ${character.name}`}</button>{owner&&<Link href={`/characters/${character.id}/edit`}>Edit character</Link>}</div>
          <div className={styles.stats}><div><span>Your messages</span><strong>{compact(viewerMessageCount)}</strong></div><div><span>Likes</span><strong>{compact(character.likeCount||0)}</strong></div><div><span>Openings</span><strong>{openings}</strong></div><div><span>Worlds</span><strong>{worlds.length}</strong></div></div>
        </div>
      </section>
      <nav className={styles.sectionNav} aria-label="Character page sections">{sections.map((section)=><button key={section.id} className={active===section.id?styles.active:""} onClick={()=>navigate(section.id)}><span>{section.icon}</span>{section.label}</button>)}</nav>
      <div className={styles.layout}>
        <div className={styles.primary}>
          <section id="overview" className={`${styles.card} ${pulse==="overview"?styles.pulse:""}`}><header><span>✦</span><h2>Overview</h2></header><div className={styles.prose}>{character.backstory||character.personality||character.scenario?<>{character.backstory&&<p>{character.backstory}</p>}{character.personality&&<p>{character.personality}</p>}{character.scenario&&<p>{character.scenario}</p>}</>:<Empty title="No overview yet" text="The creator has not added a public description."/>}</div></section>
          <section className={styles.card}><header><span>◇</span><h2>Quick facts</h2></header><Empty title="No quick facts yet" text="Creator-configurable facts will appear here when available."/></section>
          <section id="highlights" className={`${styles.card} ${pulse==="highlights"?styles.pulse:""}`}><header><span>✧</span><h2>Highlights</h2></header>{character.cast.length?<div className={styles.cast}>{character.cast.map((member)=><article key={member.name}><strong>{member.name}</strong>{member.role&&<span>{member.role}</span>}<p>{member.description}</p></article>)}</div>:<Empty title="No highlights yet" text="Public highlights are separate from private story memory."/>}</section>
          <section id="world" className={`${styles.card} ${pulse==="world"?styles.pulse:""}`}><header><span>◎</span><h2>World</h2></header>{worlds.length?<div className={styles.worlds}>{worlds.map((world)=><article key={world.id}><strong>{world.name}</strong>{world.description&&<p>{world.description}</p>}<details><summary>Read world notes</summary><p>{world.content}</p></details></article>)}</div>:<Empty title="No public world attached" text="This character can still be used without a shared world document."/>}</section>
          <section className={styles.card}><header><span>#</span><h2>Tags</h2></header><Empty title="No tags yet" text="Afterglow does not have a canonical character-tag dataset yet, so none are inferred."/>{character.nsfwEnabled&&<p className={styles.adult}>18+ · This character may generate mature fictional content.</p>}</section>
          <section id="gallery" className={`${styles.card} ${pulse==="gallery"?styles.pulse:""}`}><header><span>▧</span><h2>Gallery</h2></header><Empty title="No gallery images yet" text="The main character image is preserved as the hero; future gallery media will appear here."/></section>
          <section id="comments" className={`${styles.card} ${pulse==="comments"?styles.pulse:""}`}><header><span>☆</span><h2>Comments</h2></header><Empty title="Comments aren’t available yet" text="No review or comment data is fabricated for this character."/></section>
        </div>
        <aside className={styles.supporting}>
          <section className={styles.card}><header><span>◉</span><h2>Creator</h2></header><div className={styles.creator}><div>{initials(creator)}</div><span><strong>{creator}</strong>{character.creator?.username&&<small>@{character.creator.username}</small>}</span></div><p>Creator attribution is public only when the account has opted into a username.</p></section>
          <section className={styles.card}><header><span>◫</span><h2>Your conversations</h2></header><Empty title="Stories stay private" text="Conversation titles and transcripts never appear on a character’s public page."/><button className={styles.secondaryCta} onClick={()=>void start()}>Start a private story</button></section>
          <section className={styles.card}><header><span>⌁</span><h2>Prompt suggestions</h2></header><Empty title="No prompts yet" text="Creator-authored prompts will appear here when supported."/></section>
        </aside>
      </div>
    </div>
  </main>;
}

function Empty({title,text}:{title:string;text:string}) {return <div className={styles.empty}><span>✦</span><div><strong>{title}</strong><p>{text}</p></div></div>;}
