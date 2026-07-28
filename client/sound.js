/* ================================================================
 * client/sound.js — 游戏音效（Web Audio API 合成）
 * ================================================================ */

const Sound = {
    _ctx: null,

    _getCtx() {
        if (!this._ctx) {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this._ctx;
    },

    /** 播放音效 */
    play(action) {
        try {
            const ctx = this._getCtx();
            if (ctx.state === 'suspended') ctx.resume();

            switch (action) {
                case 'fold':  this._tone(ctx, 220, 0.08, 'sine', 0.15); break;
                case 'check': this._tap(ctx); break;
                case 'call':  this._chip(ctx); break;
                case 'raise': this._rise(ctx); break;
                case 'allin': this._allin(ctx); break;
            }
        } catch (e) { /* 静默忽略 */ }
    },

    /** 短促纯音 */
    _tone(ctx, freq, duration, type, vol) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol || 0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
    },

    /** 过牌：轻叩 */
    _tap(ctx) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.06);
    },

    /** 跟注：筹码声 */
    _chip(ctx) {
        const now = ctx.currentTime;
        // 两个短促高频叠加模拟筹码碰撞
        [1200, 800].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = freq;
            const t = now + i * 0.03;
            gain.gain.setValueAtTime(0.18, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.08);
        });
    },

    /** 加注：上行音 */
    _rise(ctx) {
        const now = ctx.currentTime;
        [300, 450, 600].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const t = now + i * 0.06;
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t);
            osc.stop(t + 0.12);
        });
    },

    /** All-in：冲击音 */
    _allin(ctx) {
        const now = ctx.currentTime;
        // 低频冲击
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(150, now);
        osc1.frequency.exponentialRampToValueAtTime(50, now + 0.3);
        gain1.gain.setValueAtTime(0.25, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc1.connect(gain1).connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.35);

        // 高频泛音
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'square';
        osc2.frequency.setValueAtTime(800, now);
        osc2.frequency.exponentialRampToValueAtTime(200, now + 0.2);
        gain2.gain.setValueAtTime(0.1, now);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now);
        osc2.stop(now + 0.25);
    },
};
