<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  AlarmClock, BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, Coffee, Flame, Leaf, ListTodo, Pause, Play, Plus, RotateCcw,
  Settings2, Volume2, VolumeX, X,
} from 'lucide-vue-next'

const modes = [
  { id: 'focus', label: '专注', minutes: 25, icon: Flame },
  { id: 'short', label: '短休息', minutes: 5, icon: Coffee },
  { id: 'long', label: '长休息', minutes: 15, icon: Leaf },
]
const mode = ref('focus')
const durations = ref({ focus: 25, short: 5, long: 15 })
const remaining = ref(25 * 60)
const running = ref(false)
const soundOn = ref(true)
const showSettings = ref(false)
const showStats = ref(false)
const showHelp = ref(false)
const inputTask = ref('')
const selectedTaskId = ref(null)
const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const tasks = ref([
  { id: 1, title: '整理本周的设计灵感', done: false, sessions: 2 },
  { id: 2, title: '完成首页视觉稿', done: false, sessions: 1 },
  { id: 3, title: '回复合作伙伴邮件', done: true, sessions: 1 },
])
const completedSessions = ref(0)
let timer = null
const activeMode = computed(() => modes.find((item) => item.id === mode.value))
const totalSeconds = computed(() => durations.value[mode.value] * 60)
const displayTime = computed(() => `${String(Math.floor(remaining.value / 60)).padStart(2, '0')}:${String(remaining.value % 60).padStart(2, '0')}`)
const progress = computed(() => 1 - remaining.value / totalSeconds.value)
const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value))
const doneCount = computed(() => tasks.value.filter((task) => task.done).length)

function selectMode(id) {
  mode.value = id 
  running.value = false
  remaining.value = durations.value[id] * 60
}
function toggleTimer() {
  if (running.value) {
    running.value = false
    return
  }
  if (remaining.value <= 0) remaining.value = totalSeconds.value
  running.value = true
}
function resetTimer() {
  running.value = false
  remaining.value = totalSeconds.value
}
function finishSession() {
  running.value = false
  if (mode.value === 'focus') {
    completedSessions.value += 1
    if (selectedTask.value) selectedTask.value.sessions += 1
    if (soundOn.value) {
      try {
        const audio = new AudioContext()
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        oscillator.connect(gain)
        gain.connect(audio.destination)
        oscillator.frequency.value = 660
        gain.gain.value = 0.08
        oscillator.start()
        oscillator.stop(audio.currentTime + 0.22)
      } catch { /* Audio may be unavailable in some browsers. */ }
    }
    selectMode(completedSessions.value % 4 === 0 ? 'long' : 'short')
  } else {
    selectMode('focus')
  }
}
function addTask() {
  const title = inputTask.value.trim()
  if (!title) return
  const task = { id: Date.now(), title, done: false, sessions: 0 }
  tasks.value.unshift(task)
  selectedTaskId.value = task.id
  inputTask.value = ''
}
function removeTask(id) {
  tasks.value = tasks.value.filter((task) => task.id !== id)
  if (selectedTaskId.value === id) selectedTaskId.value = null
}
function setDuration(id, value) {
  durations.value[id] = Math.min(90, Math.max(1, Number(value) || 1))
  if (mode.value === id && !running.value) remaining.value = durations.value[id] * 60
}
function changeDay(direction) {
  const date = new Date()
  date.setDate(date.getDate() + direction)
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
}
const dayLabel = ref(today)
function moveDay(direction) { dayLabel.value = changeDay(direction) }
function handleKeydown(event) {
  const target = event.target
  if (event.code !== 'Space' || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return
  event.preventDefault()
  toggleTimer()
}

watch(running, (isRunning) => {
  clearInterval(timer)
  if (isRunning) timer = setInterval(() => {
    if (remaining.value > 0) remaining.value -= 1
    if (remaining.value <= 0) finishSession()
  }, 1000)
})
watch(displayTime, (value) => { document.title = `${value} · ${activeMode.value.label} | 番茄时钟` })
onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  const saved = localStorage.getItem('pomodoro-tasks')
  if (saved) {
    try { tasks.value = JSON.parse(saved) } catch { /* Ignore invalid saved data. */ }
  }
})
watch(tasks, (value) => localStorage.setItem('pomodoro-tasks', JSON.stringify(value)), { deep: true })
onUnmounted(() => {
  clearInterval(timer)
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="番茄时钟首页" @click.prevent="showStats = false">
        <span class="brand-mark"><span></span></span>
        <span class="brand-name">番茄时钟</span>
        <span class="brand-divider"></span>
        <span class="brand-caption">专注当下</span>
      </a>
      <div class="header-actions">
        <button class="icon-button sound-button" :aria-label="soundOn ? '关闭提示音' : '打开提示音'" @click="soundOn = !soundOn">
          <Volume2 v-if="soundOn" :size="18" :stroke-width="1.8" /><VolumeX v-else :size="18" :stroke-width="1.8" />
        </button>
        <button class="header-button" :class="{ selected: showStats }" @click="showStats = !showStats; showSettings = false">
          <BarChart3 :size="17" :stroke-width="1.8" /><span>数据统计</span>
        </button>
        <button class="header-button" :class="{ selected: showSettings }" @click="showSettings = !showSettings; showStats = false">
          <Settings2 :size="17" :stroke-width="1.8" /><span>设置</span>
        </button>
      </div>
    </header>

    <main class="page-content">
      <section class="focus-column" aria-label="番茄钟">
        <div class="date-row">
          <div class="date-switcher">
            <button class="date-arrow" aria-label="前一天" @click="moveDay(-1)"><ChevronLeft :size="16" /></button>
            <span>{{ dayLabel }}</span>
            <button class="date-arrow" aria-label="后一天" @click="moveDay(1)"><ChevronRight :size="16" /></button>
          </div>
          <span class="date-chip"><span class="live-dot"></span>今日专注</span>
        </div>

        <div class="timer-card" :class="`mode-${mode}`">
          <div class="timer-card-top"><span class="focus-label"><span class="label-dot"></span>{{ activeMode.label }}时间</span><button class="quiet-icon" aria-label="帮助" @click="showHelp = true"><CircleHelp :size="17" /></button></div>
          <div class="timer-wrap">
            <svg class="timer-ring" viewBox="0 0 300 300" aria-hidden="true">
              <circle class="ring-track" cx="150" cy="150" r="137" />
              <circle class="ring-progress" cx="150" cy="150" r="137" :style="{ strokeDashoffset: `${861 * (1 - progress)}` }" />
            </svg>
            <div class="timer-center">
              <div class="timer-time" aria-live="off">{{ displayTime }}</div>
              <div class="timer-caption">{{ running ? '保持专注 · 你做得很好' : '慢下来，专注眼前' }}</div>
              <div class="timer-session"><span class="tiny-tomato"><span></span></span><span>第 {{ completedSessions + 1 }} 个番茄</span></div>
            </div>
          </div>
          <div class="mode-selector" role="tablist" aria-label="计时模式">
            <button v-for="item in modes" :key="item.id" class="mode-tab" :class="{ active: mode === item.id }" role="tab" :aria-selected="mode === item.id" @click="selectMode(item.id)">
              <component :is="item.icon" :size="15" :stroke-width="1.8" /><span>{{ item.label }}</span>
            </button>
          </div>
          <div class="timer-actions">
            <button class="reset-button" aria-label="重置计时器" @click="resetTimer"><RotateCcw :size="18" :stroke-width="1.8" /></button>
            <button class="start-button" @click="toggleTimer"><Pause v-if="running" :size="18" fill="currentColor" /><Play v-else :size="18" fill="currentColor" /><span>{{ running ? '暂停专注' : '开始专注' }}</span></button>
            <button class="skip-button" aria-label="跳过当前阶段" @click="finishSession"><ChevronRight :size="20" /></button>
          </div>
          <div class="keyboard-hint"><span class="keycap">空格</span> 开始 / 暂停</div>
        </div>

        <div class="quote-card"><div class="quote-mark">“</div><div><p>专注于当下，时间自会给你答案。</p><span>给自己一点耐心，每一步都算数。</span></div><div class="quote-sparkle">✳</div></div>
      </section>

      <aside class="side-column">
        <section class="task-card">
          <div class="section-heading"><div><div class="eyebrow">STAY ON TRACK</div><h2>今日任务</h2></div><button class="task-count" :aria-label="`${doneCount} 项已完成`"><Check :size="13" />{{ doneCount }}/{{ tasks.length }}</button></div>
          <form class="task-input-row" @submit.prevent="addTask"><Plus :size="17" /><input v-model="inputTask" aria-label="添加新任务" placeholder="添加一个要专注的任务..." /><button class="input-submit" aria-label="添加任务" type="submit"><ChevronRight :size="16" /></button></form>
          <div class="task-list">
            <div v-for="task in tasks" :key="task.id" class="task-item" :class="{ completed: task.done, chosen: selectedTaskId === task.id }" @click="selectedTaskId = task.id === selectedTaskId ? null : task.id">
              <button class="task-check" :aria-label="task.done ? '标记未完成' : '标记完成'" @click.stop="task.done = !task.done"><Check v-if="task.done" :size="13" :stroke-width="2.4" /></button>
              <span class="task-title">{{ task.title }}</span>
              <span class="task-pomodoros"><span class="tiny-tomato small"><span></span></span>{{ task.sessions }}</span>
              <button class="task-remove" aria-label="删除任务" @click.stop="removeTask(task.id)"><X :size="14" /></button>
            </div>
            <div v-if="tasks.length === 0" class="empty-tasks"><ListTodo :size="21" /><span>还没有任务，添加一项开始吧</span></div>
          </div>
          <div class="task-footer"><span>完成任务后，给自己一个小小的奖励。</span><ChevronDown :size="14" /></div>
        </section>

        <section class="summary-card"><div class="summary-heading"><div><div class="eyebrow">YOUR PROGRESS</div><h2>专注概览</h2></div><button class="period-button" @click="showStats = !showStats">今天 <ChevronDown :size="13" /></button></div>
          <div class="metrics-row"><div class="metric"><span class="metric-icon tomato-metric"><span class="tiny-tomato"><span></span></span></span><strong>{{ completedSessions }}</strong><span class="metric-label">完成番茄</span></div><div class="metric-divider"></div><div class="metric"><span class="metric-icon time-metric"><AlarmClock :size="17" /></span><strong>{{ Math.floor(completedSessions * durations.focus / 60) }}<small>h</small> {{ (completedSessions * durations.focus) % 60 }}<small>m</small></strong><span class="metric-label">专注时长</span></div><div class="metric-divider"></div><div class="metric"><span class="metric-icon streak-metric"><Flame :size="17" /></span><strong>{{ completedSessions ? 1 : 0 }}<small>天</small></strong><span class="metric-label">连续专注</span></div></div>
          <div class="weekly-row"><div class="weekly-copy"><span>本周目标</span><strong>{{ Math.min(completedSessions, 20) }}<small> / 20 个番茄</small></strong></div><div class="weekly-progress"><span :style="{ width: `${Math.min(completedSessions / 20 * 100, 100)}%` }"></span></div><div class="week-days"><span v-for="(day, index) in ['一', '二', '三', '四', '五', '六', '日']" :key="day" :class="{ current: index === (new Date().getDay() + 6) % 7 }">{{ day }}</span></div></div>
        </section>
        <div class="tip-card"><div class="tip-icon"><Leaf :size="17" /></div><div><strong>小小提醒</strong><p>休息也是专注的一部分，记得起来活动一下。</p></div></div>
      </aside>
    </main>

    <footer class="page-footer"><span>把注意力留给重要的事。</span><span class="footer-separator">·</span><span>一段一段，刚刚好。</span><span class="footer-right">让每一刻，都有意义 <span>✳</span></span></footer>

    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">MAKE IT YOURS</div><h2>计时设置</h2></div><button class="quiet-icon" aria-label="关闭" @click="showSettings = false"><X :size="18" /></button></div><p class="modal-description">根据自己的节奏，调整每个阶段的时长。</p><label v-for="item in modes" :key="item.id" class="setting-row"><span><component :is="item.icon" :size="16" />{{ item.label }}</span><div class="number-input"><input :value="durations[item.id]" type="number" min="1" max="90" :aria-label="`${item.label}时长（分钟）`" @change="setDuration(item.id, $event.target.value)" /><span>分钟</span></div></label><div class="modal-note">每完成 4 个专注番茄后，将自动进入长休息。</div><button class="modal-done" @click="showSettings = false">完成</button></section></div>
    <div v-if="showStats" class="modal-backdrop" @click.self="showStats = false"><section class="modal-card stats-modal"><div class="modal-heading"><div><div class="eyebrow">YOUR PROGRESS</div><h2>专注统计</h2></div><button class="quiet-icon" aria-label="关闭" @click="showStats = false"><X :size="18" /></button></div><p class="modal-description">{{ dayLabel }} · 慢慢来，每一点专注都值得记下。</p><div class="stats-big"><div><strong>{{ completedSessions }}</strong><span>完成番茄</span></div><div><strong>{{ completedSessions * durations.focus }}<small> 分钟</small></strong><span>累积专注</span></div><div><strong>{{ doneCount }}</strong><span>完成任务</span></div></div><div class="stats-empty"><BarChart3 :size="20" /><span>继续保持，你的专注记录会在这里慢慢累积。</span></div><button class="modal-done" @click="showStats = false">好的</button></section></div>
    <div v-if="showHelp" class="modal-backdrop" @click.self="showHelp = false"><section class="modal-card help-modal"><div class="modal-heading"><div><div class="eyebrow">A LITTLE GUIDE</div><h2>番茄工作法</h2></div><button class="quiet-icon" aria-label="关闭" @click="showHelp = false"><X :size="18" /></button></div><p class="modal-description">把时间切成一小段一小段，专心完成眼前的事。</p><ol class="guide-list"><li><span>01</span><div><strong>选一件事</strong><p>在今日任务里选择你接下来要做的事。</p></div></li><li><span>02</span><div><strong>专注 25 分钟</strong><p>关掉干扰，把注意力留给这一件事。</p></div></li><li><span>03</span><div><strong>休息一下</strong><p>每个番茄后休息 5 分钟，4 个番茄后休息 15 分钟。</p></div></li></ol><button class="modal-done" @click="showHelp = false">我知道了</button></section></div>
  </div>
</template>
