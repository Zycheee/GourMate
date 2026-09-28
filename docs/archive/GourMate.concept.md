# GourMate (ChefSight) — Original Concept

> **Archived input — not a specification.**
> This is the original one-page concept that seeded the project. It is superseded
> by [`specs/gourmate.spec.md`](../../specs/gourmate.spec.md) and the decision
> records in [`docs/decisions/`](../decisions/) (techstack, architecture,
> design). It is kept for provenance only. Where it disagrees with the current
> docs it loses — notably it proposes browser-native Web Speech API + Groq,
> which were replaced by server-side faster-whisper STT + edge-tts and
> Gemini 2.5 Flash, and its system prompt predates the tool-calling contract.

---

# **Project Overview: ChefSight**

**GourMate** is an eyes-up, hands-free conversational voice assistant built for home cooks and kitchen staff. It replaces salmonella-covered touchscreens with a low-latency voice agent that advances recipe steps, manages kitchen crises, runs multi-dish timers, and provides real-time ingredient substitutions.

### **What It Does**

* **Step-by-Step Navigation:** Advances through recipe instructions sequentially, reads steps aloud, and repeats details based on natural phrases like *"What’s next?"* or *"How much butter was that?"* without losing your place.  
* **Hands-Free Timers (Tool Calling):** Translates spoken requests (e.g., *"Set a pasta timer for 8 minutes"*) into live, animated on-screen countdown timers via LLM function calling.  
* **Emergency Kitchen Triage:** Provides real-time guidance when things go wrong mid-cook—such as burning pans, scorching garlic, or broken sauces—without resetting the recipe flow.  
* **Instant Ingredient Substitutions:** Recommends alternative ingredients and adjusted ratios on the fly if you are missing an item.  
* **Zero-Cost, Privacy-Conscious Stack:** Operates using browser-native speech tools (Web Speech API and Text-to-Speech) backed by free-tier LLM inference (Groq/Gemini), keeping API keys securely stored server-side.

**TechStack**

	**Frontend:** React, Tailwind.css

	**Backend:** Python

### **Core Functional Capabilities**

#### **1\. Linear Recipe Navigation**

Tracks active step index. It understands implicit navigation cues:

* *"What's next?"* $\rightarrow$ advances state to step $N+1$.  
*   
* *"Repeat that last part."* $\rightarrow$ replays step $N$.  
*   
* *"Wait, how much butter was that?"* $\rightarrow$ references ingredient quantities from prior context without resetting steps.  
* 

#### **2\. Functional Tool Calling (Timers & Widgets)**

When the user speaks a temporal instruction (*"Set a timer for the pasta for 8 minutes"*), the model calls a local schema:

JSON

1. {  
2.   "name": "create\_kitchen\_timer",  
3.   "parameters": {  
4.     "label": "Pasta",  
5.     "duration\_seconds": 480  
6.   }  
7. }

The frontend catches the JSON call and mounts an animated circular progress ring directly on screen.

#### **3\. Real-Time Emergency Culinary Triage**

If something goes wrong, the bot handles non-linear questions without losing recipe context:

* *"My garlic is starting to brown too fast, what do I do?"*  
*   
* **Response:** *"Take the pan off the heat immediately and splash in a tablespoon of water or wine to drop the pan's temperature."*  
* 

#### **4\. Dynamic Ingredient Substitutions**

Converts measurements and ingredients dynamically:

* *"I don't have heavy cream."*  
*   
* **Response:** *"Mix 3/4 cup whole milk with 1/4 cup melted butter. It provides the same fat content for this sauce."*  
* 

### **System Prompt (Copy-Paste Ready)**

Plaintext  
You are ChefSight, a hands-free voice cooking assistant. The user is actively cooking with messy or wet hands.

CURRENT RECIPE STATE:  
\- Dish: Garlic Butter Seared Salmon & Asparagus  
\- Current Step: Step 3 of 6 ("Sear salmon skin-side down for 4 minutes without moving it.")  
\- Ingredients: Salmon fillets (2), Butter (2 tbsp), Garlic (3 cloves minced), Asparagus (1 bunch), Olive oil, Salt, Pepper.

CONVERSATIONAL RULES:  
1\. Speak concisely. Keep responses under 2-3 sentences. The user is listening while cooking.  
2\. Never output markdown formatting, asterisks, or bullet points in your spoken response. Output clean, conversational plain text.  
3\. If the user asks to start a timer, change a step, or substitute an item, trigger the appropriate tool/function call.  
4\. If a cooking disaster is mentioned (burning, smoking, curdling), provide immediate emergency actions first.
