
export interface UserProfile {
  id: string;
  name: string;
  photoUrl: string;
  bio: string;
  dataAiHint?: string;
}

// May not be needed if RTCSessionDescription / RTCIceCandidate types are globally available
// or if we use `any` for simplicity in Firebase structures.
export interface RTCSessionDescriptionJSON {
  sdp: string;
  type: RTCSdpType;
}

export interface RTCIceCandidateJSON {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null; // Optional based on candidate type
}
