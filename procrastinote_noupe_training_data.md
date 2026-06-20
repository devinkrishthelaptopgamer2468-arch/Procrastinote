# Procrastinote AI Chatbot Training & Knowledge Base Document

> **Platform Note:** Feed this document directly into the **Noupe Knowledge Base** dashboard (by copying the contents or uploading this markdown file). This trains the chatbot to answer questions about the **Procrastinote** application with 100% accuracy, representing its actual codebase, features, and user guide.

---

## Part 1: AI Chatbot Persona & Guiding Instructions

*   **Name:** Procrastinote Assistant / Procrastinote AI
*   **Role:** Knowledge assistant and support agent for the **Procrastinote Educational Planner** web application.
*   **Tone:** Friendly, encouraging, student-centric, organized, and helpful.
*   **Objective:** Explain features, assist with onboarding, guide users through configuration, troubleshoot common issues, and showcase how Procrastinote helps students reduce stress.

---

## Part 2: Product Reference & Knowledge Base

### 1. What is Procrastinote?
Procrastinote is a personal school planner application built to help students manage day orders, uniform rules, homework assignments, and focus sessions. It aims to reduce academic cognitive load, prevent forgetfulness, and provide a calming study environment.

### 2. Core Modules & Functionality
*   **Dashboard (Main Hub):**
    *   **Greeting:** Dynamically welcomes the student using their first name.
    *   **Day Order Tracking:** Automatically calculates tomorrow's Day Order and displays it.
    *   **Uniform Reminder:** Informs the student which uniform is required tomorrow (e.g., Regular Uniform vs. Sports Uniform) based on the current Day Order.
    *   **Backpack Checklist:** Saves students from carrying heavy bags. It dynamically lists **"Pack These Books"** (subjects on tomorrow's schedule) and **"Leave at Home"** (subjects not on tomorrow's schedule) by cross-referencing tomorrow's subjects with all other active subjects.
    *   **Homework Alert:** Lists urgent homework tasks that are due within the next 3 days.
*   **Timetable & School Setup:**
    *   **Schedule Customization:** Allows students to define their timetable for each Day Order (supports up to 10 Day Orders and 8 subject periods per day).
    *   **School Setup Configuration:** Supports custom total Day Orders and lets users update their current Day Order.
    *   **Uniform Rules Setup:** Let's users map specific uniforms (Regular or Sports Uniform) to individual Day Orders.
*   **Homework Tracker:**
    *   **Task Entry:** Add assignments specifying task details, subject (from a predefined drop-down list), and due date.
    *   **Sorting:** Homework is automatically sorted chronologically by due date.
    *   **Confetti Celebration:** Marking a homework task as "Done" triggers a fun, motivational confetti burst!
*   **Zen Mode (Focus & Productivity):**
    *   **Pomodoro Timer:** Visual study timer featuring a circular progress animation. Supports customizable study periods (10–60 minutes) and breaks (5–20 minutes).
    *   **Mascot Sidebar Mode:** When navigating away from Zen Mode, the active timer transforms into a compact mini-timer and remains pinned to the sidebar so the session is never lost.
    *   **Zen Audio Player:** Play peaceful background tracks: *Lofi Beats*, *Rain Sounds*, *Forest Sounds*, and *Ocean Waves*. Controls include play/pause, volume adjustment, and an animated music-wave graphic.
    *   **Music Sidebar Player:** Puts a mini-music player directly in the sidebar if music is playing when you switch tabs, allowing full volume and playback control on any view.
*   **User Profiles & Theme Customization:**
    *   **Light/Dark Theme:** Easily toggle between Light and Dark mode using the toggle in the sidebar. (Unauthenticated landing pages automatically load in Dark Mode).
    *   **User Profiles:** Shows the student's name, current Grade/Class, and registered email address.
*   **Security & Data Privacy:**
    *   **Local Storage Protection:** All planner data is stored in the browser's `localStorage` indexed by the user's email. Supports multiple accounts on the same device.
    *   **Password Updates:** Secure, multi-step interface for updating passwords (verifies the old password before allowing the change).
    *   **Email Verification:** Generates a 6-digit OTP code sent via email to confirm the user's identity.
    *   **AI Mascot API Key:** Allows students to enter their personal Gemini API Key under settings to fully unlock the customized AI Assistant widget.

### 3. The Mascot's Dynamic Expression
A unique interactive feature is the **Procrastinote Robot Mascot**. The robot's facial expression changes dynamically based on the student's homework checklist:
*   **Smiling Robot face (`M 40 60 Q 50 68 60 60`):** Appears when there is no overdue homework.
*   **Frowning Robot face (`M 40 65 Q 50 55 60 65`):** Automatically appears if one or more homework assignments in the checklist have passed their due dates.

---

## Part 3: Interactive Q&A Training Set (FAQ)

### General Questions

#### Q: What is Procrastinote?
**A:** Procrastinote is a next-generation school planner designed to make student life simple and stress-free. It helps you manage your day orders, schedules, homework, and uniform rules, while providing a dedicated "Zen Mode" with focus timers and ambient tracks to boost your productivity.

#### Q: Where is my planner data saved?
**A:** Your data is securely saved directly in your browser's local storage (`localStorage`). This means your schedules, homework, and settings remain private to your device. You can also sign out or sign in with different emails, allowing multiple students to use the same device independently!

#### Q: How do I change between Light and Dark mode?
**A:** You can change your theme instantly at any time! Just use the **"Light Mode" / "Dark Mode"** toggle switch located at the bottom of the sidebar. When you are logged out, the landing page is set to a sleek dark theme by default.

---

### Dashboard & Schedules FAQ

#### Q: How does the Day Order system work?
**A:** Many schools use a rotating Day Order schedule (e.g., a 6-day cycle) rather than standard weekdays. Procrastinote lets you specify your total Day Orders (under settings) and set your current Day Order. The dashboard then automatically calculates tomorrow's Day Order so you can plan ahead!

#### Q: What is the Backpack Checklist?
**A:** The Backpack Checklist is a smart feature designed to prevent you from carrying unnecessary textbooks. Based on tomorrow's Day Order schedule, it scans your timetable and separates subjects into two lists: **"Pack These Books"** (subjects you have tomorrow) and **"Leave at Home"** (subjects you don't have tomorrow). It updates dynamically as you change your schedule!

#### Q: Why is my uniform reminder showing "Not Set up"?
**A:** This means you haven't assigned a uniform rule for tomorrow's Day Order yet. To fix this, navigate to the **Timetable** tab, scroll down to **Uniform Rules**, choose either "Regular Uniform" or "Sports Uniform" for that Day Order, and click **Save Uniforms**.

---

### Homework FAQ

#### Q: How do I add homework?
**A:** Go to the **Homework** tab. Enter a task description (e.g., "History Essay"), select the corresponding subject from the custom drop-down list, pick the deadline date, and click **Add Homework**. It will immediately appear in your active homework list, sorted chronologically so you can see what is due first.

#### Q: What happens when I finish my homework?
**A:** When you complete a task, click the **Mark Done** button next to it. Doing so removes it from your active list and triggers a beautiful confetti explosion to celebrate your productivity!

#### Q: Why does the Procrastinote mascot look sad/frowning?
**A:** The robot mascot in the corner reflects your schedule health! If it is frowning, it means you have one or more homework tasks that are **overdue** (past their deadline). Once you finish those overdue assignments or mark them as done, your mascot will immediately smile again!

---

### Zen Mode FAQ

#### Q: What is Zen Mode?
**A:** Zen Mode is a productivity sanctuary designed to help you focus. It features a customizable Pomodoro study timer and a selection of ambient background tracks to keep you in the zone.

#### Q: How do I change the study or break time lengths?
**A:** In the **Zen** tab, under the Pomodoro timer, you will see dropdown menus for **Study Time** (customizable from 10 to 60 minutes) and **Break Time** (customizable from 5 to 20 minutes). Simply select your preferred intervals!

#### Q: What ambient sounds are available?
**A:** You can choose from four high-quality, soothing ambient sounds:
1.  **Lofi Beats:** Cozy, relaxing beats for deep study.
2.  **Rain Sounds:** Gentle, steady rain to block out noise.
3.  **Forest Sounds:** Calming rustling leaves and wilderness tones.
4.  **Ocean Waves:** Soft tide sounds to soothe your mind.
*Best experienced with headphones!*

#### Q: Will my timer reset if I click on another tab?
**A:** No! Procrastinote features a smart sidebar integration. If your timer is running or has progress, navigating away from the **Zen** tab will automatically dock the visual timer as a mini-display inside the sidebar. You can keep track of your focus session from anywhere in the app!

#### Q: How do I control music when I am in the Timetable or Homework tab?
**A:** If music is playing when you switch tabs, a mini audio player automatically docks inside the sidebar. It displays the active track name and features a Play/Pause button alongside a volume slider so you can adjust your soundtrack easily without interrupting your work.

---

### Security & Troubleshooting

#### Q: How do I change my account password?
**A:** Navigate to the **Settings** tab and click on the **Security** card. Under "Change Password", enter your current password to verify your identity. Once verified, the interface will prompt you to enter and confirm your new password.

#### Q: How do I verify my email address?
**A:** In the **Security Settings** view, find the "Verify Email" card and click **Send Verification Code**. Procrastinote will send a 6-digit OTP code to your registered email. Enter the code on the screen and click **Verify Code** to confirm.

#### Q: What is the Gemini API Key under Security?
**A:** The built-in chat widget in the corner (Procrastinote AI) is powered by Gemini! Under **Security Settings**, you can enter your own Gemini API key to customize and power your direct mascot chat widget.

#### Q: Why is my schedule or homework missing?
**A:** Since all data is stored locally in your browser's local storage:
1. Make sure you are logged into the correct email account.
2. Ensure you haven't cleared your browser cookies or site data recently. 
3. If you are using a different device, your local data won't transfer automatically unless you use the same browser profiles.
