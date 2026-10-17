using UnityEngine;

/// <summary>An exit. While open (not blocked), nothing within the fire's exit clearance (1.5 m horizontally) ignites.</summary>
// ponytail: no sign sprite / floor ring yet (the web ExitSign visuals); add when the drill module needs them
public class ExitSign : MonoBehaviour
{
    public bool blocked;
}
