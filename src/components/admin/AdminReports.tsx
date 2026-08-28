"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Flag, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { AppMenuButton } from "@/components/ui";
import styles from "./admin-reports.module.css";

type Report={id:string;reporterUserId:string;reason:string;details:string;status:string;createdAt:string;capturedAt:string|null};
type Group={characterId:string|null;characterName:string;creator:{id:string;username:string;displayName:string};current:Record<string,unknown>|null;snapshot:unknown;reportCount:number;latestAt:string;priority:boolean;reports:Report[];actions:Array<{id:string;action:string;reason:string;moderatorUserId:string;createdAt:string}>};
const reasonLabels:Record<string,string>={underage:"Underage sexual content",real_person:"Real person",stolen:"Stolen creation",other:"Other",nonconsensual:"Non-consensual (legacy)",harassment:"Harassment (legacy)"};

export function AdminReports({onOpenMenu}:{onOpenMenu:()=>void}){
  const [groups,setGroups]=useState<Group[]>([]);const [selected,setSelected]=useState<Group|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [busy,setBusy]=useState("");const [filter,setFilter]=useState("active");
  const load=useCallback(async()=>{setLoading(true);setError("");try{const data=await api<{groups:Group[]}>(`/api/admin/reports?status=${filter}`);setGroups(data.groups);setSelected((current)=>data.groups.find((group)=>group.characterId===current?.characterId)??data.groups[0]??null);}catch(reason){setError(reason instanceof Error?reason.message:"Could not load reports");}finally{setLoading(false);}},[filter]);
  useEffect(()=>{void load();},[load]);
  async function act(reportId:string,action:string){
    const destructive=action==="remove_creation";const restore=action==="restore_creation";
    if((destructive||restore)&&!window.confirm(destructive?"Remove this creation from every public surface and lock it from republishing?":"Restore this creation’s previous visibility without sending publication notifications?"))return;
    const reason=destructive?(window.prompt("Moderation reason shown to the creator:","Removed after safety review")||""):"";
    if(destructive&&!reason)return;
    setBusy(action);setError("");try{await api(`/api/admin/reports/${reportId}`,{method:"POST",body:JSON.stringify({action,reason})});await load();}catch(cause){setError(cause instanceof Error?cause.message:"Moderation action failed");}finally{setBusy("");}
  }
  const anchor=selected?.reports[0];
  return <main className={styles.page}>
    <header><AppMenuButton onOpen={onOpenMenu}/><div><span>Moderation</span><h1>Creation reports</h1></div><div className={styles.filters}>{["active","closed","all"].map((item)=><button key={item} data-active={filter===item} onClick={()=>setFilter(item)}>{item}</button>)}</div></header>
    {error&&<p className={styles.error} role="alert">{error}<button onClick={()=>void load()}>Retry</button></p>}
    <div className={styles.layout}>
      <aside className={styles.queue} aria-label="Reported creations">
        {loading?<p>Loading reports…</p>:!groups.length?<div className={styles.empty}><CheckCircle2/><strong>Queue clear</strong><span>No reports in this view.</span></div>:groups.map((group)=><button key={group.characterId??group.reports[0].id} data-active={selected?.characterId===group.characterId} onClick={()=>setSelected(group)}>
          <span className={group.priority?styles.priority:styles.flag}>{group.priority?<ShieldAlert size={17}/>:<Flag size={17}/>}</span><span><strong>{group.characterName}</strong><small>{group.reportCount} report{group.reportCount===1?"":"s"} · {new Date(group.latestAt).toLocaleDateString()}</small></span>
        </button>)}
      </aside>
      <section className={styles.detail}>
        {!selected?<div className={styles.empty}><Flag/><strong>Select a reported creation</strong></div>:<>
          <div className={styles.title}><div><span>{selected.priority?"Priority review":"Reported creation"}</span><h2>{selected.characterName}</h2><p>{selected.creator.username?<Link href={`/creators/${encodeURIComponent(selected.creator.username)}`}>@{selected.creator.username}</Link>:selected.creator.displayName} · {selected.reportCount} report{selected.reportCount===1?"":"s"}</p></div>{selected.characterId&&<Link className={styles.open} href={`/characters/${selected.characterId}`}><ExternalLink size={14}/>Open</Link>}</div>
          {anchor&&<div className={styles.actions}>
            <button disabled={!!busy} onClick={()=>void act(anchor.id,"mark_reviewing")}><AlertTriangle size={14}/>Reviewing</button>
            <button disabled={!!busy} onClick={()=>void act(anchor.id,"dismiss")}><XCircle size={14}/>Dismiss</button>
            <button disabled={!!busy} onClick={()=>void act(anchor.id,"resolve_no_removal")}><CheckCircle2 size={14}/>Resolve, keep live</button>
            {selected.current?.moderationStatus==="removed"?<button disabled={!!busy} onClick={()=>void act(anchor.id,"restore_creation")}><RotateCcw size={14}/>Restore / unlock</button>:<button className={styles.danger} disabled={!!busy||!selected.current} onClick={()=>void act(anchor.id,"remove_creation")}><ShieldAlert size={14}/>Remove creation</button>}
          </div>}
          <div className={styles.reports}><h3>Reports</h3>{selected.reports.map((report)=><article key={report.id} data-priority={report.reason==="underage"}><div><strong>{reasonLabels[report.reason]??report.reason}</strong><span>{report.status} · {new Date(report.createdAt).toLocaleString()}</span></div>{report.details&&<p>{report.details}</p>}<small>Reporter {report.reporterUserId}</small></article>)}</div>
          {selected.actions.length>0&&<div className={styles.reports}><h3>Immutable action history</h3>{selected.actions.map((action)=><article key={action.id}><div><strong>{action.action.replaceAll("_"," ")}</strong><span>{new Date(action.createdAt).toLocaleString()}</span></div>{action.reason&&<p>{action.reason}</p>}<small>Moderator {action.moderatorUserId}</small></article>)}</div>}
          <div className={styles.compare}><section><h3>Current state</h3><pre>{JSON.stringify(selected.current,null,2)}</pre></section><section><h3>Evidence snapshot</h3><pre>{JSON.stringify(selected.snapshot,null,2)}</pre></section></div>
        </>}
      </section>
    </div>
  </main>;
}
