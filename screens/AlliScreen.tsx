import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
  Animated,
  Dimensions,
  Easing,
  PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../contexts/AppContext';
// Import core LiveKit classes from livekit-client
import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  RemoteAudioTrack,
  createLocalAudioTrack,
} from 'livekit-client';
// Import React Native-specific features from @livekit/react-native
import {
  AudioSession,
  registerGlobals,
  AndroidAudioTypePresets,
} from '@livekit/react-native';

registerGlobals();

// Configuration
const LIVEKIT_URL = process.env.EXPO_PUBLIC_LIVEKIT_URL || 'wss://alli-h8mq663x.livekit.cloud';
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'http://62.72.35.123:8003/start_call2';
const NOVITA_API_URL = process.env.EXPO_PUBLIC_NOVITA_API_URL;
const NOVITA_API_KEY = process.env.EXPO_PUBLIC_NOVITA_API_KEY;
const NOVITA_MODEL = process.env.EXPO_PUBLIC_NOVITA_MODEL;
const RAG_FALLBACK_URL = process.env.EXPO_PUBLIC_RAG_FALLBACK_URL;

interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  type: 'text';
  pending?: boolean;
}

// Typing indicator dots animation
function TypingIndicator() {
  const dot1 = React.useRef(new Animated.Value(0)).current;
  const dot2 = React.useRef(new Animated.Value(0)).current;
  const dot3 = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(600 - delay),
        ])
      );
    };
    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

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

const Typewriter = ({ text }: { text: string }) => {
  const [displayed, setDisplayed] = useState('');

  useEffect(() => {
    setDisplayed('');
    let i = 0;
    const timer = setInterval(() => {
      if (i < text.length) {
        setDisplayed(prev => prev + text.charAt(i));
        i++;
      } else {
        clearInterval(timer);
      }
    }, 15); // Adjust speed here
    return () => clearInterval(timer);
  }, [text]);

  return <Text style={styles.aiMessageText}>{displayed}</Text>;
};

interface AlliScreenProps {
  navigation: any;
}

type AgentState = 'connecting' | 'initializing' | 'listening' | 'speaking' | 'thinking';

export default function AlliScreen({ navigation }: AlliScreenProps) {
  const { state, getTodaysTotals } = useApp();

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showChat, setShowChat] = useState(false);

  // Voice state
  const [room, setRoom] = useState<Room | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [localTrack, setLocalTrack] = useState<LocalAudioTrack | null>(null);
  const [agentState, setAgentState] = useState<AgentState>('listening');
  const [audioLevel, setAudioLevel] = useState(0);
  const [currentUserText, setCurrentUserText] = useState('');
  const [currentAgentText, setCurrentAgentText] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Refs
  const scrollViewRef = useRef<ScrollView>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const audioLevelSmoothRef = useRef(0);
  const lastSpeakingTime = useRef(Date.now());
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const todaysTotals = getTodaysTotals();
  const goals = state.nutritionGoals;

  // Pulse animation
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    return () => loop.stop();
  }, [pulse]);

  // Auto-scroll messages
  useEffect(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [messages, currentUserText, currentAgentText]);

  // Audio level decay
  useEffect(() => {
    const decayInterval = setInterval(() => {
      const timeSinceLastSpeak = Date.now() - lastSpeakingTime.current;
      if (timeSinceLastSpeak > 200 && audioLevelSmoothRef.current > 0.01) {
        audioLevelSmoothRef.current *= 0.85;
        setAudioLevel(audioLevelSmoothRef.current);
        if (audioLevelSmoothRef.current < 0.01) {
          audioLevelSmoothRef.current = 0;
          setAudioLevel(0);
        }
      }
    }, 50);
    return () => clearInterval(decayInterval);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      if (room) {
        room.disconnect();
      }
    };
  }, [room]);

  const updateAudioLevel = (level: number) => {
    const smoothingFactor = 0.3;
    audioLevelSmoothRef.current =
      audioLevelSmoothRef.current * (1 - smoothingFactor) + level * smoothingFactor;
    setAudioLevel(audioLevelSmoothRef.current);
    if (level > 0.01) {
      lastSpeakingTime.current = Date.now();
    }
  };

  // ===== CHAT FUNCTIONS =====
  const sendMessage = async () => {
    if (!inputText.trim()) return;

    const question = inputText.trim();
    setInputText('');
    setIsProcessing(true);

    const optimisticUser: Message = {
      id: `local-user-${Date.now()}`,
      text: question,
      isUser: true,
      timestamp: new Date(),
      type: 'text',
    };

    const optimisticAI: Message = {
      id: `local-ai-${Date.now() + 1}`, // Ensure unique ID
      text: '...',
      isUser: false,
      timestamp: new Date(),
      type: 'text',
      pending: true,
    };

    setMessages(prev => [...prev, optimisticUser, optimisticAI]);

    try {
      const systemPrompt =
        `You are Alli, a friendly and supportive nutrition assistant. Your goal is to help people eat better and feel healthier.

IMPORTANT RULES FOR HOW YOU RESPOND:

1. USE SIMPLE LANGUAGE
   - Explain everything like you're talking to a friend who knows nothing about nutrition
   - Avoid scientific words, medical terms, and jargon
   - If you must use a technical term, explain it simply in parentheses
   - Example: Say "good fats" instead of "unsaturated fatty acids"
   - Example: Say "helps your body fight sickness" instead of "boosts immune function"

2. BE WARM AND ENCOURAGING
   - Use a friendly, conversational tone
   - Celebrate small wins and progress
   - Never shame or judge food choices
   - Be supportive, not preachy

3. GIVE PRACTICAL ADVICE
   - Focus on easy, actionable tips people can actually do
   - Suggest simple food swaps, not complete diet overhauls
   - Consider that people are busy and may not cook elaborate meals
   - Give specific examples and portion sizes in everyday terms (like "a handful" or "about the size of your fist")

4. FORMAT FOR EASY READING
   - Use short paragraphs
   - Use bullet points for lists
   - Bold important points
   - Break up long explanations into digestible chunks

5. BE HONEST AND SAFE
   - Don't diagnose medical conditions
   - Recommend seeing a doctor for health concerns
   - Acknowledge when something is debated or uncertain
   - Don't promise specific results

Remember: Your user might be confused, overwhelmed, or just starting their health journey. Make nutrition feel approachable and doable, not complicated or scary.`;


      // Filter out pending messages when sending to API
      const messagesToSend = [
        { role: 'system' as const, content: systemPrompt },
        ...messages.filter(m => !m.pending).map(m => ({ role: m.isUser ? 'user' as const : 'assistant' as const, content: m.text })),
        { role: 'user' as const, content: question }
      ];

      let assistantText = '';
      let novitaError = '';

      // 1. Try Novita API
      try {
        const res = await fetch(NOVITA_API_URL as string, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NOVITA_API_KEY}`,
          },
          body: JSON.stringify({
            model: NOVITA_MODEL,
            messages: messagesToSend,
            temperature: 0.3,
            max_tokens: 800,
            reasoning: { enabled: false }
          }),
        });

        if (res.ok) {
          const json = await res.json();
          assistantText = String(json?.choices?.[0]?.message?.content || '').trim();
        } else {
          novitaError = `Status ${res.status}`;
          console.log(`Novita failed with ${res.status}, trying fallback...`);
        }
      } catch (e: any) {
        novitaError = e.message;
        console.log(`Novita execution failed: ${e.message}, trying fallback...`);
      }

      // 2. Fallback to RAG if needed
      if (!assistantText && RAG_FALLBACK_URL) {
        try {
          console.log(`Falling back to RAG endpoint: ${RAG_FALLBACK_URL}`);
          const ragRes = await fetch(RAG_FALLBACK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: question }),
          });

          if (ragRes.ok) {
            const ragJson = await ragRes.json().catch(() => ({}));
            console.log('RAG Response JSON:', JSON.stringify(ragJson));
            assistantText = String(ragJson.output || ragJson.response || ragJson.text || ragJson.message || (typeof ragJson === 'string' ? ragJson : '')).trim();
            if (!assistantText) {
              console.warn('RAG returned success but no text content was found in known fields.');
            }
          } else {
            const errorText = await ragRes.text().catch(() => 'Could not read error body');
            console.error(`RAG Fallback failed with status ${ragRes.status}:`, errorText);
          }
        } catch (ragErr: any) {
          console.error('RAG Fallback execution failed:', ragErr.message || ragErr);
        }
      }

      if (assistantText) {
        const aiMessage: Message = {
          id: String(Date.now() + 1),
          text: assistantText,
          isUser: false,
          timestamp: new Date(),
          type: 'text',
        };
        // Replace optimistic AI message with real one
        setMessages(prev => {
          const filtered = prev.filter(m => m.id !== optimisticAI.id);
          return [...filtered, aiMessage];
        });
      } else {
        const finalErrorMessage = novitaError
          ? `Novita failed (${novitaError}) and RAG fallback provided no response.`
          : 'All assistants failed to respond. Please try again later.';
        throw new Error(finalErrorMessage);
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      Alert.alert('Error', `Failed to get response: ${error.message}`);
      // Remove optimistic pending message on error
      setMessages(prev => prev.filter(m => m.id !== optimisticAI.id));
    } finally {
      setIsProcessing(false);
    }
  };

  const sendQuickMessage = (message: string) => {
    setInputText(message);
    setTimeout(() => sendMessage(), 100);
  };

  // ===== VOICE FUNCTIONS =====
  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  };

  const setupAudioSession = async () => {
    try {
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: ['speaker'],
          audioTypeOptions: AndroidAudioTypePresets.Communication,
        },
        ios: {
          defaultOutput: 'speaker',
        },
      });
      await AudioSession.startAudioSession();
    } catch (err) {
      console.error('❌ Error configuring AudioSession:', err);
    }
  };

  const stopAudioSession = async () => {
    try {
      await AudioSession.stopAudioSession();
    } catch (err) {
      console.error('❌ Error stopping AudioSession:', err);
    }
  };

  const connectToRoom = async (token: string) => {
    try {
      setAgentState('connecting');
      setConnectionError(null);
      await setupAudioSession();

      connectionTimeoutRef.current = setTimeout(() => {
        setConnectionError('Connection timeout - please check your network and try again');
        setAgentState('listening');
        handleDisconnect();
      }, 15000);

      const r = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      r.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === 'audio') {
          const audioTrack = track as RemoteAudioTrack;
          audioTrack.setVolume(1.0);
          // TODO: audioLevelChanged is deprecated. Use createAudioAnalyser instead.
          /*
          audioTrack.on('audioLevelChanged', (level: number) => {
            if (level > 0.005) {
              setAgentState('speaking');
              const scaledLevel = Math.min(1, Math.pow(level * 8, 0.8));
              updateAudioLevel(Math.min(1, scaledLevel));
            } else {
              if (Date.now() - lastSpeakingTime.current > 250) {
                setAgentState('listening');
              }
            }
          });
          */
        }
      });

      r.on(RoomEvent.TranscriptionReceived, (transcriptions, participant) => {
        transcriptions.forEach((transcription) => {
          const isAgent = participant?.identity !== r.localParticipant.identity;
          const text = transcription.text;

          if (isAgent) {
            setCurrentAgentText(text);
            if (transcription.final) {
              const aiMessage: Message = {
                id: String(Date.now() + 1),
                text,
                isUser: false,
                timestamp: new Date(),
                type: 'text',
              };
              setMessages(prev => [...prev, aiMessage]);
              setCurrentAgentText('');
            }
          } else {
            setCurrentUserText(text);
            if (transcription.final) {
              const userMessage: Message = {
                id: Date.now().toString(),
                text,
                isUser: true,
                timestamp: new Date(),
                type: 'text',
              };
              setMessages(prev => [...prev, userMessage]);
              setCurrentUserText('');
            }
          }
        });
      });

      r.on(RoomEvent.LocalTrackPublished, (trackPub) => {
        const track = trackPub.track;
        if (track && track.kind === 'audio') {
          // TODO: audioLevelChanged is deprecated. Use createAudioAnalyser instead.
          /*
          track.on('audioLevelChanged', (level: number) => {
            if (level > 0.005) {
              setAgentState('thinking');
              const scaledLevel = Math.pow(level * 12, 0.7);
              updateAudioLevel(Math.min(1, scaledLevel));
            } else {
              if (agentState === 'thinking') {
                setAgentState('listening');
              }
            }
          });
          */
        }
      });

      r.on(RoomEvent.Connected, () => {
        console.log('✅ Connected to LiveKit room');
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
        }
        setConnected(true);
        setAgentState('initializing');
        setConnectionError(null);
        setTimeout(() => {
          setAgentState('listening');
          setAudioLevel(0);
        }, 1000);
      });

      r.on(RoomEvent.Disconnected, (reason) => {
        console.log('❌ Disconnected from LiveKit room:', reason);
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
        }
        setConnected(false);
        setAgentState('listening');
        setAudioLevel(0);
        audioLevelSmoothRef.current = 0;
        if (reason) {
          setConnectionError(`Disconnected: ${reason}`);
        }
      });

      r.on(RoomEvent.ConnectionStateChanged, (state) => {
        console.log('🔌 Connection state:', state);
      });

      setAgentState('initializing');
      const track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setLocalTrack(track);

      await r.connect(LIVEKIT_URL, token);
      await r.localParticipant.publishTrack(track);

      setRoom(r);
    } catch (err: any) {
      console.error('❌ LiveKit connection error:', err);
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }

      let errorMessage = 'Connection failed';
      if (err.message) {
        errorMessage = err.message;
      }

      setConnectionError(errorMessage);
      Alert.alert('Connection Error', errorMessage);
      setAgentState('listening');
      setAudioLevel(0);
      await stopAudioSession();
    }
  };

  const handleConnect = async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      Alert.alert('Permission Required', 'Microphone permission is required for voice chat');
      return;
    }

    setAgentState('connecting');
    setConnectionError(null);

    try {
      const requestBody = {
        agent_id: '123',
        roomName: `room-123-${Date.now()}`,
      };

      console.log('🔌 Connecting to backend:', BACKEND_URL);
      const response = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (!data?.data?.token) {
        throw new Error('No token received from backend');
      }

      await connectToRoom(data.data.token);
    } catch (err: any) {
      console.error('❌ Error getting token:', err);

      let errorMessage = 'Failed to connect to voice service';
      if (err.message.includes('Network request failed')) {
        errorMessage = 'Network error - please check your internet connection';
      } else if (err.message.includes('timeout')) {
        errorMessage = 'Connection timeout - please try again';
      } else if (err.message) {
        errorMessage = err.message;
      }

      setConnectionError(errorMessage);
      Alert.alert('Connection Error', errorMessage);
      setAgentState('listening');
      setAudioLevel(0);
    }
  };

  const handleDisconnect = async () => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }

    if (room) {
      if (localTrack) {
        localTrack.stop();
        setLocalTrack(null);
      }
      room.disconnect();
      setRoom(null);
    }

    setConnected(false);
    setAgentState('listening');
    setAudioLevel(0);
    audioLevelSmoothRef.current = 0;
    await stopAudioSession();
  };

  const handleMuteToggle = async () => {
    if (localTrack) {
      if (muted) {
        await localTrack.unmute();
      } else {
        await localTrack.mute();
      }
      setMuted(!muted);
    }
  };

  const getStateText = () => {
    switch (agentState) {
      case 'connecting':
        return 'Connecting...';
      case 'initializing':
        return 'Initializing...';
      case 'listening':
        return 'Listening...';
      case 'thinking':
        return 'Processing...';
      case 'speaking':
        return 'Alli is speaking...';
      default:
        return '';
    }
  };

  const getOrbColor = () => {
    switch (agentState) {
      case 'speaking':
        return '#E97451';
      case 'thinking':
        return '#9B87F5';
      case 'connecting':
      case 'initializing':
        return '#94A3B8';
      default:
        return '#B9A68D';
    }
  };

  // ===== RENDER FUNCTIONS =====
  const renderMessage = (message: Message, isLast: boolean) => {
    if (message.pending && !message.isUser) {
      return (
        <View key={message.id} style={[styles.messageContainer, styles.aiMessage]}>
          <TypingIndicator />
        </View>
      );
    }
    return (
      <View
        key={message.id}
        style={[
          styles.messageContainer,
          message.isUser ? styles.userMessage : styles.aiMessage,
        ]}
      >
        <View
          style={[
            styles.messageBubble,
            message.isUser ? styles.userBubble : styles.aiBubble,
          ]}
        >
          {isLast && !message.isUser ? (
            <Typewriter text={message.text} />
          ) : (
            <Text
              style={[
                styles.messageText,
                message.isUser ? styles.userMessageText : styles.aiMessageText,
              ]}
            >
              {message.text}
            </Text>
          )}
          <Text
            style={[
              styles.timestamp,
              message.isUser ? styles.userTimestamp : styles.aiTimestamp,
            ]}
          >
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  const renderQuickSuggestions = () => {
    const suggestions = [
      "What should my meal plan be?",
      "How do I lose weight?",
      "Give me meal ideas",
      "What can you help me with?",
    ];

    return (
      <View style={styles.suggestionsContainer}>
        <Text style={styles.suggestionsTitle}>Quick Questions:</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.suggestionsScrollContent}
        >
          {suggestions.map((suggestion, index) => (
            <TouchableOpacity
              key={index}
              style={styles.suggestionButton}
              onPress={() => sendQuickMessage(suggestion)}
            >
              <Text style={styles.suggestionText}>{suggestion}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
        {/* Error Banner */}
        {connectionError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>⚠️ {connectionError}</Text>
            <TouchableOpacity onPress={() => setConnectionError(null)}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        )}

        <KeyboardAvoidingView
          style={styles.keyboardAvoidingView}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {/* Centered pulsating Alli avatar */}
          <View style={styles.centerHeroContainer}>
            <Animated.View
              style={{
                transform: [
                  {
                    scale: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1.08 + audioLevel * 0.2]
                    }),
                  },
                ],
              }}
            >
              <LinearGradient
                colors={[getOrbColor(), '#6E006A', '#4F0232']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.pulseRing}
              >
                <View style={styles.pulseInner}>
                  <Image source={require('../assets/Chick2.png')} style={styles.heroImage} />
                </View>
              </LinearGradient>
            </Animated.View>

            {/* Voice control buttons */}
            <View style={styles.voiceButtonsContainer}>
              {/* Chat Toggle Button */}
              <TouchableOpacity
                style={[
                  styles.voiceButton,
                  styles.chatToggleButtonInline,
                  showChat && styles.chatToggleButtonActive,
                ]}
                onPress={() => setShowChat(!showChat)}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={showChat ? "chatbubbles" : "chatbubble-outline"}
                  size={28}
                  color={showChat ? "white" : "#0090A3"}
                />
                {!showChat && messages.length > 0 && (
                  <View style={styles.chatBadgeInline}>
                    <Text style={styles.chatBadgeText}>{messages.length}</Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Voice Button */}
              {!connected ? (
                <TouchableOpacity
                  style={[styles.voiceButton, styles.micButton]}
                  onPress={handleConnect}
                  activeOpacity={0.8}
                  disabled={agentState === 'connecting'}
                >
                  <Ionicons
                    name="mic"
                    size={32}
                    color={agentState === 'connecting' ? "#999" : "#0090A3"}
                  />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.voiceButton, styles.endButton]}
                  onPress={handleDisconnect}
                  activeOpacity={0.8}
                >
                  <Ionicons name="close" size={32} color="white" />
                </TouchableOpacity>
              )}

              {/* Mute Button (when connected) */}
              {connected && (
                <TouchableOpacity
                  style={[styles.voiceButton, styles.muteButton, muted && styles.mutedButton]}
                  onPress={handleMuteToggle}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={muted ? "mic-off" : "mic"}
                    size={24}
                    color={muted ? "#FF6B6B" : "#0090A3"}
                  />
                </TouchableOpacity>
              )}
            </View>

            {/* Status text */}
            <Text style={styles.statusText}>
              {currentUserText || currentAgentText || getStateText()}
            </Text>
          </View>

          {/* Chat Interface - Only visible when showChat is true */}
          {showChat && (
            <>
              {/* Messages */}
              <ScrollView
                ref={scrollViewRef}
                style={styles.messagesContainer}
                contentContainerStyle={styles.messagesContent}
                onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
              >
                {messages.length === 0 ? (
                  <View style={styles.centerHeroContainer}>
                    <Text style={styles.statusText}>{getStateText()}</Text>
                  </View>
                ) : (
                  messages.map((message, index) => renderMessage(message, index === messages.length - 1))
                )}
              </ScrollView>
              {/* Quick Suggestions */}
              {messages.length <= 1 && renderQuickSuggestions()}

              {/* Input */}
              <View style={styles.inputContainer}>
                <TextInput
                  style={styles.textInput}
                  value={inputText}
                  onChangeText={setInputText}
                  placeholder="Ask Alli anything about nutrition..."
                  placeholderTextColor="#999"
                  multiline
                  maxLength={500}
                />
                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    !inputText.trim() && styles.sendButtonDisabled,
                  ]}
                  onPress={sendMessage}
                  disabled={!inputText.trim() || isProcessing}
                >
                  <Ionicons
                    name="send"
                    size={20}
                    color={inputText.trim() && !isProcessing ? '#B9A68D' : '#ccc'}
                  />
                </TouchableOpacity>
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#CDC4B7',
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#FCA5A5',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: '#991B1B',
    fontWeight: '500',
  },
  dismissText: {
    fontSize: 13,
    color: '#DC2626',
    fontWeight: '600',
    marginLeft: 12,
  },
  centerHeroContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 24,
    paddingBottom: 16,
  },
  voiceButtonsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    gap: 12,
  },
  chatToggleButtonInline: {
    backgroundColor: '#E6E1D8',
    borderWidth: 2,
    borderColor: '#0090A3',
  },
  chatToggleButtonActive: {
    backgroundColor: '#6E006A',
    borderColor: '#6E006A',
  },
  chatBadgeInline: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#FF6B6B',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  voiceButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  micButton: {
    backgroundColor: '#E6E1D8',
    borderWidth: 2,
    borderColor: '#0090A3',
  },
  endButton: {
    backgroundColor: '#FF6B6B',
    borderWidth: 2,
    borderColor: '#FF6B6B',
  },
  muteButton: {
    backgroundColor: '#E6E1D8',
    borderWidth: 2,
    borderColor: '#0090A3',
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  mutedButton: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FF6B6B',
  },
  statusText: {
    marginTop: 12,
    fontSize: 16,
    color: '#0090A3',
    fontWeight: '600',
    textAlign: 'center',
    minHeight: 24,
  },
  pulseRing: {
    width: Dimensions.get('window').width * 0.6,
    height: Dimensions.get('window').width * 0.6,
    borderRadius: Dimensions.get('window').width * 0.3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseInner: {
    width: '94%',
    height: '94%',
    borderRadius: Dimensions.get('window').width * 0.28,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroImage: {
    width: '100%',
    height: '100%',
    borderRadius: Dimensions.get('window').width * 0.28,
    resizeMode: 'cover',
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 20,
    paddingBottom: 120,
  },
  messageContainer: {
    marginBottom: 16,
  },
  userMessage: {
    alignItems: 'flex-end',
  },
  aiMessage: {
    alignItems: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 16,
  },
  userBubble: {
    backgroundColor: '#0090A3',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: '#E6E1D8',
    borderBottomLeftRadius: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  userMessageText: {
    color: 'white',
  },
  aiMessageText: {
    color: '#2A2A2A',
  },
  timestamp: {
    fontSize: 12,
    marginTop: 4,
  },
  userTimestamp: {
    color: 'rgba(255, 255, 255, 0.7)',
    textAlign: 'right',
  },
  aiTimestamp: {
    color: '#999',
  },
  suggestionsContainer: {
    padding: 20,
    paddingTop: 0,
  },
  suggestionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0090A3',
    marginBottom: 12,
  },
  suggestionsScrollContent: {
    paddingRight: 20,
  },
  suggestionButton: {
    backgroundColor: '#E6E1D8',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  suggestionText: {
    fontSize: 14,
    color: '#0090A3',
    fontWeight: '500',
  },
  chatBadgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#E6E1D8',
    paddingHorizontal: 20,
    paddingVertical: 12,
    paddingBottom: 100,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 12,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F8F9FA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#F0F0F0',
  },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#E6E1D8',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    minHeight: 46,
    minWidth: 60,
    justifyContent: 'center',
    // alignSelf: 'flex-start',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#6E006A',
    marginHorizontal: 3,
  },
});