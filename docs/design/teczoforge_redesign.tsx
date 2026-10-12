import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, 
  Image as ImageIcon, 
  LayoutDashboard, 
  MessageSquare, 
  Folder, 
  Edit2, 
  X, 
  Paperclip, 
  Send,
  Hexagon,
  Settings,
  User,
  LogOut
} from 'lucide-react';

const NAV_ITEMS = [
  { id: 'generate', label: 'Generate', icon: Sparkles },
  { id: 'gallery', label: 'Gallery', icon: ImageIcon },
  { id: 'board', label: 'Board', icon: LayoutDashboard },
  { id: 'projects', label: 'Projects', icon: Folder },
];

const CHAT_HISTORY = [
  { id: 1, title: 'FRG-34 test: remove...' },
  { id: 2, title: 'plan a fantasy cha...' },
  { id: 3, title: 'Plan a scene: a co...' },
  { id: 4, title: 'WastewaterTeczo setup' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('chat');
  const [activeChat, setActiveChat] = useState(1);
  const [message, setMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  
  const settingsRef = useRef(null);

  // Close settings when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (settingsRef.current && !settingsRef.current.contains(event.target)) {
        setShowSettings(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="flex flex-row h-screen bg-slate-900 text-slate-300 font-sans overflow-hidden selection:bg-teal-500/30">
      
      <aside className="w-72 bg-slate-800 border-r border-slate-700/50 flex flex-col shrink-0 shadow-xl z-20">
        
        {/* Top: Logo */}
        <div className="flex items-center gap-3 px-5 py-5 h-16 shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-teal-500/20 to-teal-600/10 border border-teal-500/20 text-teal-400">
            <Hexagon size={20} className="fill-teal-500/10" />
          </div>
          <span className="text-xl font-semibold tracking-wide text-slate-100">
            teczo<span className="text-teal-500 font-light">Forge</span>
          </span>
        </div>

        {/* Action: New Chat */}
        <div className="px-4 pb-4 shrink-0">
          <button className="w-full flex items-center justify-center gap-2 bg-teal-600/90 hover:bg-teal-500 text-white py-2.5 px-4 rounded-xl text-sm font-medium shadow-sm shadow-teal-900/20 transition-all duration-200">
            <Sparkles size={16} />
            New chat
          </button>
        </div>

        {/* Navigation List */}
        <nav className="px-2 pb-4 space-y-1 shrink-0 border-b border-slate-700/50 mx-2">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                  isActive 
                    ? 'bg-slate-700/50 text-teal-400' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
                }`}
              >
                <Icon size={16} className={isActive ? 'text-teal-400' : 'text-slate-500'} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Scrollable Chat History */}
        <div className="flex-1 overflow-y-auto px-2 pt-4 pb-4 space-y-0.5 custom-scrollbar">
          <div className="px-3 pb-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Recent
          </div>
          {CHAT_HISTORY.map((chat) => (
            <div
              key={chat.id}
              onClick={() => {
                setActiveChat(chat.id);
                setActiveTab('chat');
              }}
              className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 ${
                activeChat === chat.id && activeTab === 'chat'
                  ? 'bg-slate-700/80 text-teal-100'
                  : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-3 truncate pr-2">
                <MessageSquare size={14} className={activeChat === chat.id && activeTab === 'chat' ? 'text-teal-400' : 'text-slate-500'} />
                <span className="text-sm truncate">{chat.title}</span>
              </div>
              
              {/* Hover Actions */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="p-1.5 text-slate-400 hover:text-slate-200 rounded-md hover:bg-slate-600 transition-colors" title="Edit">
                  <Edit2 size={12} />
                </button>
                <button className="p-1.5 text-slate-400 hover:text-slate-200 rounded-md hover:bg-slate-600 transition-colors" title="Move to Project">
                  <Folder size={12} />
                </button>
                <button className="p-1.5 text-slate-400 hover:text-red-400 rounded-md hover:bg-slate-600 transition-colors" title="Delete">
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
        
        {/* Bottom: Profile & Settings */}
        <div className="p-4 border-t border-slate-700/50 relative" ref={settingsRef}>
          
          {/* Pop-up Settings Menu */}
          {showSettings && (
            <div className="absolute bottom-full left-4 right-4 mb-2 bg-slate-700 border border-slate-600 rounded-xl shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-slate-300 hover:text-white hover:bg-slate-600 transition-colors">
                <User size={16} className="text-slate-400" />
                My Account
              </button>
              <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-slate-300 hover:text-white hover:bg-slate-600 transition-colors">
                <Settings size={16} className="text-slate-400" />
                Preferences
              </button>
              <div className="h-px bg-slate-600 my-1 mx-2"></div>
              <button className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-slate-600 transition-colors">
                <LogOut size={16} />
                Log out
              </button>
            </div>
          )}

          {/* Profile Button */}
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className={`w-full flex items-center gap-3 p-2 rounded-xl transition-all duration-200 ${
              showSettings ? 'bg-slate-700' : 'hover:bg-slate-700/50'
            }`}
          >
            <div className="flex items-center justify-center w-9 h-9 rounded-full bg-teal-700/80 text-teal-100 font-semibold text-sm border border-teal-600 shrink-0">
              J
            </div>
            <div className="flex flex-col items-start truncate">
              <span className="text-sm font-medium text-slate-200">jaya</span>
              <span className="text-xs text-slate-500 font-medium">Free Plan</span>
            </div>
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative min-w-0">
        
        {/* Top Header: Status Indicators */}
        <header className="flex items-center justify-end h-14 px-6 shrink-0 z-10">
          <div className="flex items-center gap-5 bg-slate-800/50 px-4 py-1.5 rounded-full border border-slate-700/50 backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-medium text-slate-400">Backend <span className="text-emerald-500/90">Online</span></span>
            </div>
            <div className="w-px h-3 bg-slate-700"></div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-medium text-slate-400">ComfyUI <span className="text-emerald-500/90">Online</span></span>
            </div>
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto px-8 flex flex-col max-w-5xl mx-auto w-full">
          {activeTab === 'chat' ? (
             <div className="text-sm text-slate-500 font-medium mt-4 pb-32">
                Plan a scene or ask for a prompt. Claude answers short. The chat text is sent to the Claude API on the internet; images and videos are still made on this PC.
             </div>
          ) : (
             <div className="flex flex-col items-center justify-center h-full text-slate-500">
               <span className="text-lg font-medium capitalize">{activeTab} Area</span>
               <span className="text-sm mt-2">Content for {activeTab} goes here.</span>
             </div>
          )}
        </div>

        {/* Floating Premium Input Box */}
        <div className="absolute bottom-6 left-0 right-0 px-8 flex justify-center pb-2">
          <div className="w-full max-w-4xl bg-slate-800/90 backdrop-blur-xl border border-slate-700 shadow-2xl shadow-black/50 rounded-2xl p-2.5 flex flex-col gap-1 transition-all focus-within:border-teal-500/50 focus-within:ring-4 focus-within:ring-teal-500/10">
            
            {/* Textarea */}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type a message. Enter sends, Shift+Enter makes a new line."
              className="w-full bg-transparent text-slate-100 placeholder-slate-500 resize-none outline-none px-3 py-2 text-sm min-h-[50px] max-h-[250px] custom-scrollbar"
              rows={1}
            />
            
            {/* Input Controls */}
            <div className="flex items-center justify-between px-1">
              <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700/80 transition-colors font-medium">
                <Paperclip size={16} />
                Attach
              </button>

              <div className="flex items-center gap-4">
                <span className="text-xs text-slate-500 font-medium">
                  {message.length} / 8000
                </span>
                <button 
                  className={`flex items-center justify-center h-9 w-9 rounded-xl transition-all duration-200 ${
                    message.trim() 
                      ? 'bg-teal-600 text-white hover:bg-teal-500 shadow-lg shadow-teal-900/40' 
                      : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  }`}
                >
                  <Send size={16} className={message.trim() ? 'ml-0.5' : ''} />
                </button>
              </div>
            </div>
          </div>
        </div>

      </main>
      
      {/* Scrollbar Styles */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #334155; /* slate-700 */
          border-radius: 20px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background-color: #475569; /* slate-600 */
        }
        
        /* Basic animations for dropdown */
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slide-in-from-bottom-2 {
          from { transform: translateY(0.5rem); }
          to { transform: translateY(0); }
        }
        .animate-in {
          animation-duration: 150ms;
          animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
          animation-fill-mode: both;
        }
        .fade-in { animation-name: fade-in; }
        .slide-in-from-bottom-2 { animation-name: slide-in-from-bottom-2; }
      `}} />
    </div>
  );
}