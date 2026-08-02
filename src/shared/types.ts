export type Platform='douyin'|'kuaishou'|'xiaohongshu'|'toutiao'|'weixin'|'bilibili'|'qqmedia';
export type LoginStatus='checking'|'logged_in'|'logged_out';
export interface Account{id:string;platform:Platform;name:string;remark?:string;createdAt:string;lastOpenedAt?:string;loginStatus:LoginStatus}
export type ContentType='video'|'image_text';export type TaskStatus='pending'|'opening'|'uploading'|'publishing'|'manual_required'|'success'|'failed';
export interface PublishDraft{id:string;type:ContentType;title:string;description:string;topics:string[];mediaPaths:string[];coverPath?:string;accountIds:string[];createdAt:string}
export interface PublishTask{id:string;draftId:string;accountId:string;platform:Platform;title:string;status:TaskStatus;message:string;createdAt:string;updatedAt:string}
export interface AppData{accounts:Account[];drafts:PublishDraft[];tasks:PublishTask[]}
export interface AccountInput{platform:Platform}
export interface BrowserBounds{x:number;y:number;width:number;height:number}
