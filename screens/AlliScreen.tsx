import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, Alert, Image, Animated,
  Dimensions, Easing, PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../contexts/AppContext';
import { parseMealPlanFromMessage, MEAL_PLAN_SYSTEM_PROMPT } from '../lib/mealPlanUtils';
import { ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import {
  Room, RoomEvent, LocalAudioTrack, RemoteAudioTrack, createLocalAudioTrack,
} from 'livekit-client';
import { AudioSession, registerGlobals, AndroidAudioTypePresets } from '@livekit/react-native';

registerGlobals();

// ─── Constants ────────────────────────────────────────────────────────────────
const GOOGLE_CLOUD_API_KEY = 'AIzaSyCVeazis9qamy7KHrM8-ibkRlb5myrMwMQ';
const AI_STUDIO_API_KEY = 'AIzaSyBeHnLfd4rO7IjQyLzyEvlKWi78O0waGsE';
const GOOGLE_TTS_URL = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_CLOUD_API_KEY}`;
const GEMINI_REST_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${AI_STUDIO_API_KEY}`;
const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL || 'wss://tgs-g8ihpbv8.livekit.cloud';
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://165.227.28.126:8005/start_call2';

const VOICE_RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.m4a', outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000, numberOfChannels: 1, bitRate: 128000,
  },
  ios: {
    extension: '.m4a', outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000, numberOfChannels: 1, bitRate: 128000,
    linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false,
  },
  web: {},
};

const VOICE_SYSTEM_PROMPT = `You are Alli, a highly knowledgeable and friendly nutrition specialist having a voice conversation. Keep responses concise and conversational — suitable for speaking aloud (2–4 sentences max unless a full meal plan is requested). Be warm, supportive, and evidence-based. For meal plan requests, generate the complete structured plan. Always remind users to consult healthcare professionals for personalized medical advice.`;

// ─── Interfaces ───────────────────────────────────────────────────────────────
interface Message {
  id: string; text: string; isUser: boolean;
  timestamp: Date; type: 'text'; pending?: boolean;
}
type GeminiState = 'idle' | 'recording' | 'processing' | 'speaking';
type LiveKitState = 'disconnected' | 'connecting' | 'initializing' | 'listening' | 'thinking' | 'speaking';

// ─── Typing Indicator ─────────────────────────────────────────────────────────
function TypingIndicator() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.delay(600 - delay),
      ]));
    const a1 = animate(dot1, 0); const a2 = animate(dot2, 200); const a3 = animate(dot3, 400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);
  const dotStyle = (anim: Animated.Value) => ({
    opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.2] }) }],
  });
  return (
    <View style={styles.typingBubble}>
      <Animated.View style={[styles.typingDot, dotStyle(dot1)]} />
      <Animated.View style={[styles.typingDot, dotStyle(dot2)]} />
      <Animated.View style={[styles.typingDot, dotStyle(dot3)]} />
    </View>
  );
}

// ─── Typewriter ───────────────────────────────────────────────────────────────
function Typewriter({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState('');
  useEffect(() => {
    setDisplayed(''); let i = 0;
    const timer = setInterval(() => {
      if (i < text.length) { setDisplayed(prev => prev + text.charAt(i)); i++; }
      else clearInterval(timer);
    }, 15);
    return () => clearInterval(timer);
  }, [text]);
  return <Text style={[styles.messageText, styles.aiMessageText]}>{displayed}</Text>;
}

// ─── Add to Meal Plan Button ──────────────────────────────────────────────────
function AddToMealPlanButton({ content }: { content: string }) {
  const { createMealPlanFromChat } = useApp();
  const navigation = useNavigation<any>();
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const mealPlan = React.useMemo(() => parseMealPlanFromMessage(content), [content]);
  if (!mealPlan || mealPlan.length === 0) return null;
  const handlePress = async () => {
    if (added || adding) return;
    setAdding(true);
    try {
      const result = await createMealPlanFromChat(mealPlan);
      if (result.success) {
        setAdded(true);
        Alert.alert('✅ Meal Plan Added!',
          `${mealPlan.length} day${mealPlan.length > 1 ? 's' : ''} added to your Meal Plan.`,
          [{ text: 'OK', style: 'cancel' }, { text: 'View Plan', onPress: () => navigation.navigate('Plan') }]
        );
      } else Alert.alert('Error', (result as any).error?.message || 'Failed to add meal plan.');
    } catch { Alert.alert('Error', 'Something went wrong. Please try again.'); }
    finally { setAdding(false); }
  };
  return (
    <TouchableOpacity style={[styles.addPlanBtn, added && styles.addPlanBtnAdded]}
      onPress={handlePress} disabled={adding || added} activeOpacity={0.85}>
      {adding ? <ActivityIndicator size="small" color="#fff" /> : (
        <>
          <Ionicons name={added ? 'checkmark-circle' : 'calendar-outline'} size={18} color="#fff" style={{ marginRight: 6 }} />
          <Text style={styles.addPlanBtnText}>{added ? 'Added to Meal Plan ✓' : 'Add to Your Meal Plan'}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
interface AlliScreenProps { navigation: any; }

export default function AlliScreen({ navigation }: AlliScreenProps) {
  const { state, getTodaysTotals } = useApp();

  // Shared
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showChat, setShowChat] = useState(false);

  // Gemini voice
  const [geminiState, setGeminiState] = useState<GeminiState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // LiveKit voice
  const [lkState, setLkState] = useState<LiveKitState>('disconnected');
  const [room, setRoom] = useState<Room | null>(null);
  const [lkMuted, setLkMuted] = useState(false);
  const [localTrack, setLocalTrack] = useState<LocalAudioTrack | null>(null);
  const [currentUserText, setCurrentUserText] = useState('');
  const [currentAgentText, setCurrentAgentText] = useState('');
  const lkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const lkConnected = lkState !== 'disconnected';

  // ─── Animations ────────────────────────────────────────────────────────────
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 800, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (geminiState === 'recording') {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])).start();
    } else { pulseAnim.stopAnimation(); pulseAnim.setValue(1); }
  }, [geminiState]);

  useEffect(() => {
    setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, currentUserText, currentAgentText]);

  useEffect(() => {
    return () => {
      recordingRef.current?.stopAndUnloadAsync().catch(() => { });
      soundRef.current?.stopAsync().catch(() => { });
      soundRef.current?.unloadAsync().catch(() => { });
      if (lkTimeoutRef.current) clearTimeout(lkTimeoutRef.current);
      if (room) room.disconnect();
    };
  }, [room]);

  // ══════════════════════════════════════════════════════════════════════════════
  // GEMINI VOICE — Primary (record → Gemini STT+AI → Google TTS → play)
  // ══════════════════════════════════════════════════════════════════════════════

  const requestMicPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        Alert.alert('Permission Required', 'Microphone access is needed for voice chat.'); return false;
      }
      return true;
    }
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission Required', 'Microphone access is needed for voice chat.'); return false; }
    return true;
  };

  const startRecording = async () => {
    if (geminiState !== 'idle' || lkConnected) return;
    if (!await requestMicPermission()) return;
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(VOICE_RECORDING_OPTIONS);
      recordingRef.current = recording;
      setGeminiState('recording');
      setVoiceError(null);
      console.log('🎙️ Gemini recording started');
    } catch (e: any) {
      console.error('❌ Failed to start recording:', e);
      setVoiceError('Could not start recording');
    }
  };

  const stopAndProcess = async () => {
    if (geminiState !== 'recording' || !recordingRef.current) return;
    try {
      setGeminiState('processing');
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      if (!uri) throw new Error('No audio recorded');

      console.log('📤 Sending to Gemini...');
      const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const history = messages.filter(m => !m.pending).map(m => ({
        role: m.isUser ? 'user' : 'model',
        parts: [{ text: m.isUser ? m.text : m.text.replace(/```json[\s\S]*?```/g, '').trim() }],
      }));

      const response = await fetch(GEMINI_REST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: VOICE_SYSTEM_PROMPT + '\n\n' + MEAL_PLAN_SYSTEM_PROMPT }] },
          contents: [...history, { role: 'user', parts: [{ inline_data: { mime_type: 'audio/mp4', data: base64Audio } }] }],
          generation_config: { temperature: 0.7, max_output_tokens: 2000 },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const transcript = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!transcript) throw new Error('Empty response from Gemini');
      console.log('✅ Gemini responded. Length:', transcript.length);

      setMessages(prev => [...prev, { id: `g-${Date.now()}`, text: transcript, isUser: false, timestamp: new Date(), type: 'text' }]);
      setShowChat(true);
      await speakResponse(transcript);
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (e: any) {
      console.error('❌ Gemini voice failed:', e);
      setVoiceError(e.message);
      Alert.alert('Voice Error', e.message);
      setGeminiState('idle');
    }
  };

  const speakResponse = async (text: string): Promise<void> => {
    setGeminiState('speaking');
    const clean = text.replace(/```[\s\S]*?```/g, 'I have generated your meal plan.').replace(/[#*_`>]/g, '').replace(/\n+/g, ' ').trim();
    try {
      const ttsRes = await fetch(GOOGLE_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: clean },
          voice: { languageCode: 'en-US', name: 'en-US-Neural2-F', ssmlGender: 'FEMALE' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 1.0 },
        }),
      });
      if (ttsRes.ok) {
        const ttsData = await ttsRes.json();
        const audioUri = FileSystem.cacheDirectory + `tts_${Date.now()}.mp3`;
        await FileSystem.writeAsStringAsync(audioUri, ttsData.audioContent, { encoding: FileSystem.EncodingType.Base64 });
        const { sound } = await Audio.Sound.createAsync({ uri: audioUri });
        soundRef.current = sound;
        await sound.playAsync();
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
            FileSystem.deleteAsync(audioUri, { idempotent: true });
            setGeminiState('idle');
          }
        });
      } else {
        console.warn('⚠️ Google TTS failed:', ttsRes.status);
        setGeminiState('idle');
      }
    } catch (e: any) {
      console.error('❌ TTS error:', e.message);
      setGeminiState('idle');
    }
  };

  const stopSpeaking = async () => {
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => { });
      await soundRef.current.unloadAsync().catch(() => { });
      soundRef.current = null;
    }
    setGeminiState('idle');
  };

  const handleGeminiMicPress = () => {
    if (geminiState === 'idle') startRecording();
    else if (geminiState === 'recording') stopAndProcess();
    else if (geminiState === 'speaking') stopSpeaking();
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // LIVEKIT VOICE — Fallback (real-time streaming via backend agent)
  // ══════════════════════════════════════════════════════════════════════════════

  const setupAudioSession = async () => {
    try {
      await AudioSession.configureAudio({
        android: { preferredOutputList: ['speaker'], audioTypeOptions: AndroidAudioTypePresets.communication },
        ios: { defaultOutput: 'speaker' },
      });
      await AudioSession.startAudioSession();
    } catch (e) { console.error('AudioSession error:', e); }
  };

  const stopAudioSession = async () => { try { await AudioSession.stopAudioSession(); } catch { } };

  const connectToLiveKit = async (token: string, serverUrl?: string) => {
    try {
      setLkState('connecting');
      await setupAudioSession();

      lkTimeoutRef.current = setTimeout(() => {
        setLkState('disconnected'); handleLkDisconnect();
      }, 15000);

      const r = new Room({ adaptiveStream: true, dynacast: true });

      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === 'audio') (track as RemoteAudioTrack).setVolume(1.0);
      });

      r.on(RoomEvent.TranscriptionReceived, (transcriptions, participant) => {
        transcriptions.forEach(t => {
          const isAgent = participant?.identity !== r.localParticipant.identity;
          if (isAgent) {
            setCurrentAgentText(t.text);
            if (t.final) {
              setMessages(prev => [...prev, { id: `lk-ai-${Date.now()}`, text: t.text, isUser: false, timestamp: new Date(), type: 'text' }]);
              setCurrentAgentText('');
            }
          } else {
            setCurrentUserText(t.text);
            if (t.final) {
              setMessages(prev => [...prev, { id: `lk-u-${Date.now()}`, text: t.text, isUser: true, timestamp: new Date(), type: 'text' }]);
              setCurrentUserText('');
            }
          }
        });
      });

      r.on(RoomEvent.DataReceived, (payload) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === 'meal_plan' || data.days) {
            setMessages(prev => [...prev, {
              id: `lk-data-${Date.now()}`,
              text: `Here is your meal plan!\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
              isUser: false, timestamp: new Date(), type: 'text',
            }]);
          }
        } catch { }
      });

      r.on(RoomEvent.Connected, () => {
        if (lkTimeoutRef.current) clearTimeout(lkTimeoutRef.current);
        setLkState('initializing');
        setTimeout(() => setLkState('listening'), 1000);
      });

      r.on(RoomEvent.Disconnected, () => {
        if (lkTimeoutRef.current) clearTimeout(lkTimeoutRef.current);
        setLkState('disconnected');
        setCurrentUserText(''); setCurrentAgentText('');
      });

      const track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      setLocalTrack(track);
      await r.connect(serverUrl || LIVEKIT_URL, token);
      await r.localParticipant.publishTrack(track);
      setRoom(r);
    } catch (err: any) {
      if (lkTimeoutRef.current) clearTimeout(lkTimeoutRef.current);
      Alert.alert('LiveKit Error', err.message);
      setLkState('disconnected');
      await stopAudioSession();
    }
  };

  const handleLkConnect = async () => {
    if (!await requestMicPermission()) return;
    setLkState('connecting');
    try {
      console.log('🔄 Fetching LiveKit token...');
      const res = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: '123' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.data?.token) throw new Error('No token received');
      console.log('✅ LiveKit token received');
      await connectToLiveKit(data.data.token, data.data.url);
    } catch (err: any) {
      Alert.alert('LiveKit Error', err.message);
      setLkState('disconnected');
    }
  };

  const handleLkDisconnect = async () => {
    if (lkTimeoutRef.current) clearTimeout(lkTimeoutRef.current);
    if (room) { if (localTrack) { localTrack.stop(); setLocalTrack(null); } room.disconnect(); setRoom(null); }
    setLkState('disconnected');
    setCurrentUserText(''); setCurrentAgentText('');
    await stopAudioSession();
  };

  const handleLkMuteToggle = async () => {
    if (localTrack) { lkMuted ? await localTrack.unmute() : await localTrack.mute(); setLkMuted(!lkMuted); }
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // TEXT CHAT — OpenAI
  // ══════════════════════════════════════════════════════════════════════════════

  const sendMessage = async () => {
    if (!inputText.trim()) return;
    const question = inputText.trim();
    setInputText(''); setIsProcessing(true);

    const optimisticUser: Message = { id: `u-${Date.now()}`, text: question, isUser: true, timestamp: new Date(), type: 'text' };
    const optimisticAI: Message = { id: `a-${Date.now() + 1}`, text: '...', isUser: false, timestamp: new Date(), type: 'text', pending: true };
    setMessages(prev => [...prev, optimisticUser, optimisticAI]);

    try {
      const systemPrompt = `You are Alli, a highly knowledgeable nutrition specialist assistant with extensive expertise in nutritional science research and clinical studies.

Your expertise:
- Nutritional science and evidence-based dietary guidelines
- Macro and micronutrients (vitamins, minerals, proteins, fats, carbohydrates)
- Food composition, nutritional values, and bioavailability
- Clinical nutrition research and scientific literature
- Current nutritional guidelines from authoritative sources (WHO, USDA, FDA, European Food Safety Authority)
- Dietary recommendations for various health goals and medical conditions

Your personality:
- Professional yet approachable and friendly
- Patient and empathetic
- Non-judgmental about dietary choices
- Supportive and encouraging

Guidelines:
- Provide accurate, evidence-based nutritional information
- Ask clarifying questions when relevant
- Always remind users to consult healthcare professionals for personalized medical advice

${MEAL_PLAN_SYSTEM_PROMPT}`;

      const messagesToSend = [
        { role: 'system' as const, content: systemPrompt },
        ...messages.filter(m => !m.pending).map(m => ({
          role: m.isUser ? 'user' as const : 'assistant' as const,
          content: m.isUser ? m.text : m.text.replace(/```json[\s\S]*?```/g, '').trim(),
        })),
        { role: 'user' as const, content: question },
      ];

      let assistantText = '';
      if (OPENAI_API_KEY) {
        try {
          const controller = new AbortController();
          const isMealPlan = ['plan', 'diet', 'meal', 'week', 'food'].some(k => question.toLowerCase().includes(k));
          const tid = setTimeout(() => controller.abort(), isMealPlan ? 90_000 : 30_000);
          const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY.trim()}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: messagesToSend, temperature: 0.7, max_tokens: isMealPlan ? 4000 : 1500 }),
            signal: controller.signal,
          });
          clearTimeout(tid);
          if (res.ok) {
            const data = await res.json();
            assistantText = data?.choices?.[0]?.message?.content?.trim() || '';
            console.log('✅ OpenAI responded. Length:', assistantText.length);
          } else console.log('❌ OpenAI HTTP error:', res.status);
        } catch (e: any) { console.error('❌ OpenAI failed:', e.message); }
      }

      if (assistantText) {
        setMessages(prev => [...prev.filter(m => m.id !== optimisticAI.id), {
          id: String(Date.now() + 1), text: assistantText, isUser: false, timestamp: new Date(), type: 'text',
        }]);
      } else throw new Error('No response received. Please try again.');
    } catch (error: any) {
      Alert.alert('Error', error.message);
      setMessages(prev => prev.filter(m => m.id !== optimisticAI.id));
    } finally { setIsProcessing(false); }
  };

  const sendQuickMessage = (msg: string) => { setInputText(msg); setTimeout(() => sendMessage(), 100); };

  // ─── Status text helpers ──────────────────────────────────────────────────
  const getGeminiStatusText = () => {
    switch (geminiState) {
      case 'recording': return '🔴 Listening... tap to send';
      case 'processing': return '💜 Thinking...';
      case 'speaking': return '🟢 Alli speaking... tap to stop';
      default: return voiceError ? `⚠️ ${voiceError}` : '';
    }
  };

  const getLkStatusText = () => {
    switch (lkState) {
      case 'connecting': return 'Connecting to LiveKit...';
      case 'initializing': return 'Initializing agent...';
      case 'listening': return '🎙️ LiveKit listening...';
      case 'thinking': return 'Agent processing...';
      case 'speaking': return 'Agent speaking...';
      default: return '';
    }
  };

  const statusText = currentUserText || currentAgentText || getLkStatusText() || getGeminiStatusText() || 'Tap 🎙️ for Gemini voice  •  Tap 📡 for LiveKit voice';

  // ─── Render message ───────────────────────────────────────────────────────
  const renderMessage = (message: Message, isLast: boolean) => {
    if (message.pending && !message.isUser) return (
      <View key={message.id} style={[styles.messageContainer, styles.aiMessage]}><TypingIndicator /></View>
    );
    const displayText = message.text.replace(/```json[\s\S]*?```/g, '').trim() || '...';
    const timeStr = message.timestamp instanceof Date
      ? message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Recently';
    return (
      <View key={message.id} style={[styles.messageContainer, message.isUser ? styles.userMessage : styles.aiMessage]}>
        <View style={[styles.messageBubble, message.isUser ? styles.userBubble : styles.aiBubble]}>
          {isLast && !message.isUser
            ? <Typewriter text={displayText} />
            : <Text style={[styles.messageText, message.isUser ? styles.userMessageText : styles.aiMessageText]}>{displayText}</Text>}
          <Text style={[styles.timestamp, message.isUser ? styles.userTimestamp : styles.aiTimestamp]}>{timeStr}</Text>
        </View>
        {!message.isUser && <AddToMealPlanButton content={message.text} />}
      </View>
    );
  };

  const renderQuickSuggestions = () => (
    <View style={styles.suggestionsContainer}>
      <Text style={styles.suggestionsTitle}>Quick Questions:</Text>
      {['What should my meal plan be?', 'How do I lose weight?', 'Give me meal ideas', 'What can you help me with?'].map((s, i) => (
        <TouchableOpacity key={i} style={styles.suggestionButton} onPress={() => sendQuickMessage(s)}>
          <Text style={styles.suggestionText}>{s}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  // ─── Gemini mic button appearance ─────────────────────────────────────────
  const getGeminiMicStyle = () => {
    if (geminiState === 'recording') return [styles.voiceButton, styles.btnRecording];
    if (geminiState === 'processing') return [styles.voiceButton, styles.btnProcessing];
    if (geminiState === 'speaking') return [styles.voiceButton, styles.btnSpeaking];
    return [styles.voiceButton, styles.btnGemini];
  };
  const getGeminiMicIcon = () => {
    if (geminiState === 'recording') return 'stop-circle';
    if (geminiState === 'processing') return 'hourglass-outline';
    if (geminiState === 'speaking') return 'volume-high-outline';
    return 'mic-outline';
  };

  // ─── JSX ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardAvoidingView} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>

        {/* Hero image */}
        <Animated.View style={[styles.centerHeroContainer, { opacity: fadeAnim }]}>
          <View style={styles.pulseRing}>
            <View style={styles.pulseInner}>
              <Image source={require('../assets/Chick2copy.png')} style={styles.heroImage} />
            </View>
          </View>
        </Animated.View>

        {/* Button row */}
        <View style={styles.voiceButtonsContainer}>

          {/* Chat toggle */}
          <TouchableOpacity
            style={[styles.voiceButton, styles.btnChat, showChat && styles.btnChatActive]}
            onPress={() => setShowChat(!showChat)} activeOpacity={0.8}>
            {!showChat && messages.length > 0 && (
              <View style={styles.chatBadge}><Text style={styles.chatBadgeText}>{messages.length}</Text></View>
            )}
            <Ionicons name={showChat ? 'chatbubbles' : 'chatbubbles-outline'} size={26} color={showChat ? '#fff' : '#0090A3'} />
          </TouchableOpacity>

          {/* Gemini mic — primary voice */}
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <TouchableOpacity
              style={getGeminiMicStyle()}
              onPress={handleGeminiMicPress}
              disabled={geminiState === 'processing' || lkConnected}
              activeOpacity={0.8}>
              {geminiState === 'processing'
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name={getGeminiMicIcon() as any} size={28} color="#fff" />}
            </TouchableOpacity>
          </Animated.View>

          {/* LiveKit button — fallback */}
          {!lkConnected ? (
            <TouchableOpacity
              style={[styles.voiceButton, styles.btnLiveKit]}
              onPress={handleLkConnect}
              disabled={geminiState !== 'idle'}
              activeOpacity={0.8}>
              <Ionicons name="radio-outline" size={26} color="#6E006A" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.voiceButton, styles.btnLiveKitActive]} onPress={handleLkDisconnect} activeOpacity={0.8}>
              <Ionicons name="stop-circle-outline" size={26} color="#fff" />
            </TouchableOpacity>
          )}

          {/* LiveKit mute (only when connected) */}
          {lkConnected && (
            <TouchableOpacity
              style={[styles.voiceButton, styles.btnMute, lkMuted && styles.btnMuted]}
              onPress={handleLkMuteToggle} activeOpacity={0.8}>
              <Ionicons name={lkMuted ? 'mic-off-outline' : 'mic-outline'} size={22} color={lkMuted ? '#FF6B6B' : '#0090A3'} />
            </TouchableOpacity>
          )}
        </View>

        {/* Status label */}
        <Text style={[styles.statusText, geminiState === 'recording' && styles.statusRecording]}>
          {statusText}
        </Text>

        {/* Legend */}
        <View style={styles.legendRow}>
          <Text style={styles.legendItem}>🎙️ Gemini voice</Text>
          <Text style={styles.legendSep}>•</Text>
          <Text style={styles.legendItem}>📡 LiveKit (fallback)</Text>
        </View>

        {showChat && (
          <>
            <ScrollView ref={scrollViewRef} style={styles.messagesContainer} contentContainerStyle={styles.messagesContent}
              onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
              {messages.length === 0
                ? <Text style={styles.emptyText}>Ask Alli anything about nutrition!</Text>
                : messages.map((m, i) => renderMessage(m, i === messages.length - 1))}
              {messages.length <= 1 && renderQuickSuggestions()}
            </ScrollView>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput} value={inputText} onChangeText={setInputText}
                placeholder="Ask Alli anything about nutrition..." placeholderTextColor="#999"
                multiline onSubmitEditing={sendMessage} />
              <TouchableOpacity
                style={[styles.sendButton, (!inputText.trim() || isProcessing) && styles.sendButtonDisabled]}
                onPress={sendMessage} disabled={!inputText.trim() || isProcessing}>
                <Ionicons name="send" size={20} color={inputText.trim() && !isProcessing ? '#0090A3' : '#ccc'} />
              </TouchableOpacity>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#CDC4B7' },
  keyboardAvoidingView: { flex: 1 },
  centerHeroContainer: { alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 16 },
  pulseRing: {
    width: Dimensions.get('window').width * 0.6, height: Dimensions.get('window').width * 0.6,
    borderRadius: Dimensions.get('window').width * 0.3, alignItems: 'center', justifyContent: 'center',
  },
  pulseInner: {
    width: '94%', height: '94%', borderRadius: Dimensions.get('window').width * 0.28,
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  heroImage: { width: '100%', height: '100%', resizeMode: 'cover' },

  voiceButtonsContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 20, gap: 12 },
  voiceButton: {
    width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84, elevation: 5,
  },

  // Chat toggle
  btnChat: { backgroundColor: '#E6E1D8', borderWidth: 2, borderColor: '#0090A3' },
  btnChatActive: { backgroundColor: '#6E006A', borderColor: '#6E006A' },
  chatBadge: {
    position: 'absolute', top: -4, right: -4, backgroundColor: '#FF6B6B',
    borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  chatBadgeText: { color: 'white', fontSize: 12, fontWeight: 'bold' },

  // Gemini mic states
  btnGemini: { backgroundColor: '#0090A3', borderWidth: 2, borderColor: '#0090A3' },
  btnRecording: { backgroundColor: '#FF3B30', borderWidth: 2, borderColor: '#FF3B30' },
  btnProcessing: { backgroundColor: '#6E006A', borderWidth: 2, borderColor: '#6E006A' },
  btnSpeaking: { backgroundColor: '#059669', borderWidth: 2, borderColor: '#059669' },

  // LiveKit buttons
  btnLiveKit: { backgroundColor: '#E6E1D8', borderWidth: 2, borderColor: '#6E006A' },
  btnLiveKitActive: { backgroundColor: '#FF6B6B', borderWidth: 2, borderColor: '#FF6B6B' },
  btnMute: { backgroundColor: '#E6E1D8', borderWidth: 2, borderColor: '#0090A3', width: 56, height: 56, borderRadius: 28 },
  btnMuted: { backgroundColor: '#FEE2E2', borderColor: '#FF6B6B' },

  statusText: { marginTop: 10, fontSize: 14, color: '#0090A3', fontWeight: '600', textAlign: 'center', minHeight: 22, paddingHorizontal: 16 },
  statusRecording: { color: '#FF3B30' },

  legendRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 4, gap: 6 },
  legendItem: { fontSize: 12, color: '#888' },
  legendSep: { fontSize: 12, color: '#bbb' },

  messagesContainer: { flex: 1 },
  messagesContent: { padding: 16, paddingBottom: 120 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 40, fontSize: 15 },
  messageContainer: { marginBottom: 16 },
  userMessage: { alignItems: 'flex-end' },
  aiMessage: { alignItems: 'flex-start' },
  messageBubble: { maxWidth: '85%', padding: 12, borderRadius: 16 },
  userBubble: { backgroundColor: '#0090A3', borderBottomRightRadius: 4 },
  aiBubble: {
    backgroundColor: '#E6E1D8', borderBottomLeftRadius: 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
      android: { elevation: 2 },
    }),
  },
  messageText: { fontSize: 15, lineHeight: 22 },
  userMessageText: { color: '#fff' },
  aiMessageText: { color: '#2A2A2A' },
  timestamp: { fontSize: 11, marginTop: 4 },
  userTimestamp: { color: 'rgba(255,255,255,0.7)', textAlign: 'right' },
  aiTimestamp: { color: '#999' },

  addPlanBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0090A3', paddingVertical: 12, paddingHorizontal: 20,
    borderRadius: 12, marginTop: 8, alignSelf: 'flex-start',
    ...Platform.select({
      ios: { shadowColor: '#0090A3', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 6 },
      android: { elevation: 4 },
    }),
  },
  addPlanBtnAdded: { backgroundColor: '#059669' },
  addPlanBtnText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  suggestionsContainer: { padding: 16, paddingTop: 0 },
  suggestionsTitle: { fontSize: 15, fontWeight: '600', color: '#0090A3', marginBottom: 10 },
  suggestionButton: {
    backgroundColor: '#E6E1D8', paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, marginBottom: 8, borderWidth: 1, borderColor: '#ddd',
  },
  suggestionText: { fontSize: 13, color: '#0090A3', fontWeight: '500' },

  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#E6E1D8',
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#E0E0E0',
  },
  textInput: {
    flex: 1, borderWidth: 1, borderColor: '#E0E0E0', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
    maxHeight: 100, marginRight: 10, backgroundColor: '#fff',
  },
  sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F8F9FA', alignItems: 'center', justifyContent: 'center' },
  sendButtonDisabled: { backgroundColor: '#F0F0F0' },

  typingBubble: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    backgroundColor: '#E6E1D8', borderRadius: 16, borderBottomLeftRadius: 4,
    minHeight: 46, minWidth: 60, justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
      android: { elevation: 2 },
    }),
  },
  typingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#6E006A', marginHorizontal: 3 },
});