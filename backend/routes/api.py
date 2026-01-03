import json

from config import active_sessions, client


async def generate_report(session_id: str):
    if session_id not in active_sessions:
        return {"error": "Session not found"}

    session = active_sessions[session_id]

    try:
        prompt = f"""Generate a comprehensive evaluation report for this project presentation:

Student Name: {session.student_name or "Unknown"}
Project Name: {session.project_name or "Unknown"}

Q&A Pairs:
{json.dumps(session.qa_pairs, indent=2)}

Context: {session.context[-2000:]}
Transcript: {session.transcript[-2000:]}

Current Scores: {json.dumps(session.evaluation_scores)}

Provide:
1. Overall Assessment (2-3 paragraphs)
2. Strengths (3-4 bullet points)
3. Areas for Improvement (3-4 bullet points)
4. Technical Depth Analysis
5. Final Recommendation

Format as markdown."""

        response = await client.chat.completions.create(
            model="gpt-4",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1500,
            temperature=0.7
        )

        report = response.choices[0].message.content

        return {
            "session_id": session_id,
            "report": report,
            "scores": session.evaluation_scores,
            "questions_asked": len(session.questions_asked),
            "qa_pairs": session.qa_pairs,
            "student_name": session.student_name,
            "project_name": session.project_name
        }

    except Exception as e:
        return {"error": str(e)}


async def health_check():
    return {"status": "healthy", "active_sessions": len(active_sessions)}
